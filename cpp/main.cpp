#include <curl/curl.h>

#include <chrono>
#include <cstdlib>
#include <ctime>
#include <future>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <regex>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {

struct Config {
  std::string mode = "safe";
  std::string cookie;
  std::string statePath = ".auth/storage-state.json";
  std::string baseUrl = "https://rioc.civicpermits.com/Permits";
  std::string conflictUrl = "https://rioc.civicpermits.com/Permits/ConflictCheck";
  std::string weekdayStartTime = "19:00";
  int weekendStartHour = 8;
  int weekendEndHour = 21;
  std::string activity = "Tennis court reservation";
  bool fallbackEnabled = true;
};

struct HttpResult {
  long status = 0;
  std::string body;
};

struct AttemptStats {
  int totalTrials = 0;
  int conflictTrials = 0;
  int precheckErrors = 0;
  int submitFailures = 0;
};

struct CourtOption {
  std::string name;
  std::string id;
};

enum class ConflictStatus {
  Free,
  Conflict,
  Error
};

std::string getenvOr(const char* key, const std::string& fallback) {
  const char* value = std::getenv(key);
  if (!value) {
    return fallback;
  }
  return std::string(value);
}

bool isTruthy(const std::string& value) {
  return value == "1" || value == "true" || value == "TRUE" || value == "yes" || value == "YES";
}

int clampInt(int value, int minValue, int maxValue) {
  if (value < minValue) {
    return minValue;
  }
  if (value > maxValue) {
    return maxValue;
  }
  return value;
}

int parseIntOr(const std::string& text, int fallback) {
  try {
    return std::stoi(text);
  } catch (...) {
    return fallback;
  }
}

std::string readFile(const std::string& path) {
  std::ifstream stream(path, std::ios::in | std::ios::binary);
  if (!stream) {
    return {};
  }

  std::ostringstream buffer;
  buffer << stream.rdbuf();
  return buffer.str();
}

std::string cookieHeaderFromStorageState(const std::string& statePath) {
  const std::string content = readFile(statePath);
  if (content.empty()) {
    return {};
  }

  const std::regex cookiePattern(R"REGEX("name"\s*:\s*"([^"]+)"[\s\S]*?"value"\s*:\s*"([^"]+)")REGEX");
  std::sregex_iterator it(content.begin(), content.end(), cookiePattern);
  std::sregex_iterator end;

  std::vector<std::string> parts;
  for (; it != end; ++it) {
    const std::smatch match = *it;
    if (match.size() >= 3) {
      parts.push_back(match[1].str() + "=" + match[2].str());
    }
  }

  std::ostringstream out;
  for (size_t i = 0; i < parts.size(); ++i) {
    out << parts[i];
    if (i + 1 < parts.size()) {
      out << "; ";
    }
  }
  return out.str();
}

Config loadConfig() {
  Config config;
  config.mode = getenvOr("MODE", "safe");
  config.cookie = getenvOr("CIVIC_COOKIE", "");
  config.statePath = getenvOr("STATE_PATH", ".auth/storage-state.json");
  if (config.cookie.empty()) {
    config.cookie = cookieHeaderFromStorageState(config.statePath);
  }
  config.baseUrl = getenvOr("BASE_URL_PERMITS", "https://rioc.civicpermits.com/Permits");
  config.conflictUrl = getenvOr("BASE_URL_CONFLICT_CHECK", "https://rioc.civicpermits.com/Permits/ConflictCheck");
  config.weekdayStartTime = getenvOr("WEEKDAY_TIME", "19:00");
  config.weekendStartHour = clampInt(parseIntOr(getenvOr("WEEKEND_START_HOUR", "8"), 8), 0, 23);
  config.weekendEndHour = clampInt(parseIntOr(getenvOr("WEEKEND_END_HOUR", "21"), 21), 0, 23);
  if (config.weekendEndHour < config.weekendStartHour) {
    config.weekendEndHour = config.weekendStartHour;
  }
  config.activity = getenvOr("ACTIVITY", "Tennis court reservation");
  config.fallbackEnabled = isTruthy(getenvOr("ENABLE_FALLBACK_1D", "true"));
  return config;
}

std::string jsonEscape(const std::string& input) {
  std::ostringstream out;
  for (char c : input) {
    switch (c) {
      case '\\': out << "\\\\"; break;
      case '"': out << "\\\""; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default: out << c; break;
    }
  }
  return out.str();
}

std::string shellEscapeSingleQuotes(const std::string& input) {
  std::string escaped;
  escaped.reserve(input.size() + 8);
  for (char c : input) {
    if (c == '\'') {
      escaped += "'\\''";
    } else {
      escaped.push_back(c);
    }
  }
  return escaped;
}

void sendMacNotification(const std::string& title, const std::string& message) {
  std::string safeTitle = shellEscapeSingleQuotes(title);
  std::string safeMessage = shellEscapeSingleQuotes(message);
  std::string cmd = "/usr/bin/osascript -e 'display notification \"" + safeMessage +
                    "\" with title \"" + safeTitle + "\"' >/dev/null 2>&1";
  std::system(cmd.c_str());

  // Audible fallback in case Notification Center banners are disabled.
  std::string spoken = "/usr/bin/say '" + safeMessage + "' >/dev/null 2>&1";
  std::system(spoken.c_str());
}

std::string toIsoDate(const std::tm& tm) {
  std::ostringstream out;
  out << std::put_time(&tm, "%Y-%m-%d");
  return out.str();
}

std::string toWeekday(const std::tm& tm) {
  static const char* kWeekdays[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
  return kWeekdays[tm.tm_wday];
}

std::tm addDays(std::time_t now, int days) {
  now += static_cast<std::time_t>(days) * 24 * 60 * 60;
  std::tm result{};
#ifdef _WIN32
  localtime_s(&result, &now);
#else
  localtime_r(&now, &result);
#endif
  return result;
}

std::string buildDateTime(const std::tm& day, const std::string& hhmm) {
  int hour = 0;
  int minute = 0;
  std::sscanf(hhmm.c_str(), "%d:%d", &hour, &minute);

  std::tm copy = day;
  copy.tm_hour = hour;
  copy.tm_min = minute;
  copy.tm_sec = 0;

  std::ostringstream out;
  out << std::put_time(&copy, "%Y-%m-%dT%H:%M:%S");
  return out.str();
}

std::string addOneHour(const std::string& hhmm) {
  int hour = 0;
  int minute = 0;
  std::sscanf(hhmm.c_str(), "%d:%d", &hour, &minute);
  int total = hour * 60 + minute + 60;
  int nextHour = (total / 60) % 24;
  int nextMinute = total % 60;
  std::ostringstream out;
  out << std::setfill('0') << std::setw(2) << nextHour << ":" << std::setw(2) << nextMinute;
  return out.str();
}

std::string hourToHHMM(int hour) {
  std::ostringstream out;
  out << std::setfill('0') << std::setw(2) << hour << ":00";
  return out.str();
}

bool isWeekend(const std::tm& day) {
  return day.tm_wday == 0 || day.tm_wday == 6;
}

std::vector<std::string> buildTimeSlotsForDay(const Config& config, const std::tm& day) {
  if (!isWeekend(day)) {
    return {config.weekdayStartTime};
  }

  std::vector<std::string> slots;
  for (int hour = config.weekendStartHour; hour <= config.weekendEndHour; ++hour) {
    if (hour == 23) {
      continue;
    }
    slots.push_back(hourToHHMM(hour));
  }
  if (slots.empty()) {
    slots.push_back(config.weekdayStartTime);
  }
  return slots;
}

size_t writeCallback(void* contents, size_t size, size_t nmemb, void* userp) {
  size_t realSize = size * nmemb;
  auto* buffer = static_cast<std::string*>(userp);
  buffer->append(static_cast<char*>(contents), realSize);
  return realSize;
}

HttpResult postJson(const std::string& url, const std::string& payload, const std::string& cookie) {
  HttpResult result;

  CURL* curl = curl_easy_init();
  if (!curl) {
    result.status = 0;
    result.body = "curl_easy_init failed";
    return result;
  }

  struct curl_slist* headers = nullptr;
  headers = curl_slist_append(headers, "Content-Type: application/json; charset=utf-8");
  headers = curl_slist_append(headers, "X-Requested-With: XMLHttpRequest");

  if (!cookie.empty()) {
    std::string cookieHeader = "Cookie: " + cookie;
    headers = curl_slist_append(headers, cookieHeader.c_str());
  }

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_POST, 1L);
  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload.c_str());
  curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(payload.size()));
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &result.body);
  curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);

  CURLcode code = curl_easy_perform(curl);
  if (code != CURLE_OK) {
    result.body = curl_easy_strerror(code);
  }

  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &result.status);

  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);
  return result;
}

std::string buildPayload(
    const Config& config,
    const std::string& courtName,
    const std::string& facilityId,
    const std::string& startIso,
    const std::string& stopIso) {
  // Uses observed question ids/default responses from Civic permit form.
  const std::vector<std::pair<std::string, std::string>> responses = {
      {"11e79e5d3daf4712b9e6418d2691b976", "Tennis court reservation"},
      {"af8966101be44676b4ee564b052e1e87", "2"},
      {"f28f0dbea8b5438495778b0bb0ddcd93", "No"},
      {"d46cb434558845fb9e0318ab6832e427", "No"},
      {"1221940f5cca4abdb5288cfcbe284820", "N/A"},
      {"3754dcef7216446b9cc4bf1cd0f12a2e", "No"},
      {"0ce54956c4b14746ae5d364507da1e85", "No"},
      {"6b1dda4172f840c7879662bcab1819db", "No"},
      {"06b3f73192a84fd6b88758e56a64c3ad", "No"},
      {"a31f4297075e4dab8c0ef154f2b9b1c1", "None"},
  };

  std::ostringstream out;
  out << "{";
  out << "\"Activity\":\"" << jsonEscape(config.activity) << "\",";
  out << "\"Note\":\"\",";
  out << "\"Comments\":\"\",";
  out << "\"Events\":[{";
  out << "\"FacilityNames\":[\"" << jsonEscape(courtName) << "\"],";
  out << "\"FacilityIds\":[\"" << jsonEscape(facilityId) << "\"],";
  out << "\"Comments\":\"\",";
  out << "\"Dates\":[{";
  out << "\"Start\":\"" << startIso << "\",";
  out << "\"Stop\":\"" << stopIso << "\"";
  out << "}]";
  out << "}],";
  out << "\"IsPrivate\":false,";
  out << "\"Responses\":[";

  for (size_t i = 0; i < responses.size(); ++i) {
    out << "{"
        << "\"Id\":\"" << responses[i].first << "\","
        << "\"StringValue\":\"" << jsonEscape(responses[i].second) << "\","
        << "\"CheckboxValue\":[]"
        << "}";
    if (i + 1 < responses.size()) {
      out << ",";
    }
  }

  out << "]";
  out << "}";
  return out.str();
}

std::string buildConflictCheckPayload(
    const std::string& courtName,
    const std::string& facilityId,
    const std::string& startIso,
    const std::string& stopIso) {
  std::ostringstream out;
  out << "{";
  out << "\"FacilityNames\":[\"" << jsonEscape(courtName) << "\"],";
  out << "\"FacilityIds\":[\"" << jsonEscape(facilityId) << "\"],";
  out << "\"Comments\":\"\",";
  out << "\"Dates\":[{";
  out << "\"Start\":\"" << startIso << "\",";
  out << "\"Stop\":\"" << stopIso << "\"";
  out << "}]";
  out << "}";
  return out.str();
}

ConflictStatus getConflictStatus(const Config& config, const std::string& conflictPayload) {
  HttpResult conflictCheck = postJson(config.conflictUrl, conflictPayload, config.cookie);
  std::cout << "Conflict check HTTP " << conflictCheck.status << "\n";

  if (conflictCheck.status < 200 || conflictCheck.status >= 300) {
    std::cout << "Conflict check failed; skipping this attempt: "
              << conflictCheck.body.substr(0, 200) << "\n";
    return ConflictStatus::Error;
  }

  const std::regex emptyArrayPattern(R"(^\s*\[\s*\]\s*$)");
  if (!std::regex_match(conflictCheck.body, emptyArrayPattern)) {
    std::cout << "Timeslot already occupied according to ConflictCheck.\n";
    return ConflictStatus::Conflict;
  }

  return ConflictStatus::Free;
}

void runAttempt(const Config& config, int offsetDays, bool* submitted, AttemptStats* stats) {
  std::time_t now = std::time(nullptr);
  std::tm day = addDays(now, offsetDays);
  std::string isoDate = toIsoDate(day);
  std::string weekday = toWeekday(day);
  const std::vector<std::string> timeSlots = buildTimeSlotsForDay(config, day);

  std::cout << "Plan (" << (offsetDays > 0 ? "+" : "") << offsetDays << "d): "
            << weekday << " " << isoDate << " slots=" << timeSlots.size() << "\n";

  const std::vector<CourtOption> courts = {
      {"Octagon Tennis court 3", "9bdef00b-afa0-4b6b-bf9a-75899f7f97c7"},
      {"Octagon Tennis Court 1", "036dfea4-c487-47b0-b7fe-c9cbe52b7c98"},
      {"Octagon Tennis court 2", "175bdff8-016e-46ab-a9df-829fe40c0754"},
      {"Octagon Tennis Court 4", "d311851d-ce53-49fc-9662-42adcda26109"},
      {"Octagon Tennis Court 5", "8a5ca8e8-3be0-4145-a4ef-91a69671295b"},
      {"Octagon Tennis Court 6", "77c7f42c-8891-4818-a610-d5c1027c62fe"},
    };

  for (const auto& slot : timeSlots) {
    const std::string endTime = addOneHour(slot);
    const std::string startIso = buildDateTime(day, slot);
    const std::string stopIso = buildDateTime(day, endTime);

    std::cout << "Checking slot " << slot << "-" << endTime << "\n";

    std::vector<std::future<ConflictStatus>> conflictFutures;
    conflictFutures.reserve(courts.size());

    for (const auto& court : courts) {
      stats->totalTrials += 1;
      std::cout << "Attempting [" << (offsetDays > 0 ? "+" : "") << offsetDays << "d] "
                << court.name << " " << startIso << "\n";

      std::string conflictPayload = buildConflictCheckPayload(court.name, court.id, startIso, stopIso);
      conflictFutures.push_back(std::async(std::launch::async, [config, conflictPayload]() {
        return getConflictStatus(config, conflictPayload);
      }));
    }

    std::vector<size_t> conflictFreeIndexes;
    for (size_t i = 0; i < conflictFutures.size(); ++i) {
      const ConflictStatus status = conflictFutures[i].get();
      if (status == ConflictStatus::Free) {
        conflictFreeIndexes.push_back(i);
      } else if (status == ConflictStatus::Conflict) {
        stats->conflictTrials += 1;
      } else {
        stats->precheckErrors += 1;
      }
    }

    if (conflictFreeIndexes.empty()) {
      continue;
    }

    if (config.mode == "safe") {
      std::cout << "SAFE MODE: would submit payload to " << config.baseUrl << "\n";
      *submitted = true;
      return;
    }

    struct SubmitResult {
      size_t courtIndex;
      HttpResult result;
    };

    std::vector<std::future<SubmitResult>> submitFutures;
    submitFutures.reserve(conflictFreeIndexes.size());
    for (size_t idx : conflictFreeIndexes) {
      submitFutures.push_back(std::async(std::launch::async, [config, &courts, idx, startIso, stopIso]() {
        SubmitResult out{idx, {0, ""}};
        const auto& court = courts[idx];
        std::string payload = buildPayload(config, court.name, court.id, startIso, stopIso);
        out.result = postJson(config.baseUrl, payload, config.cookie);
        return out;
      }));
    }

    int successCount = 0;
    size_t winnerIndex = 0;
    for (auto& future : submitFutures) {
      SubmitResult submitResult = future.get();
      std::cout << "HTTP " << submitResult.result.status << "\n";
      if (submitResult.result.status >= 200 && submitResult.result.status < 300) {
        successCount += 1;
        winnerIndex = submitResult.courtIndex;
      } else {
        stats->submitFailures += 1;
        std::cout << "Failed for " << courts[submitResult.courtIndex].name << ": "
                  << submitResult.result.body.substr(0, 200) << "\n";
      }
    }

    if (successCount > 0) {
      const auto& winnerCourt = courts[winnerIndex];
      std::cout << "Submitted successfully for " << winnerCourt.name << "\n";
      std::string successMessage = "Booked " + winnerCourt.name + " on " + isoDate + " at " + slot + ".";
      if (successCount > 1) {
        successMessage += " Multiple court submissions succeeded; review permits.";
      }
      sendMacNotification("Octagon Booker", successMessage);
      *submitted = true;
      return;
    }
  }
}

}  // namespace

int main() {
  curl_global_init(CURL_GLOBAL_DEFAULT);

  Config config = loadConfig();
  if (config.mode != "safe" && config.cookie.empty()) {
    std::cerr << "CIVIC_COOKIE is required for MODE=auto\n";
    curl_global_cleanup();
    return 2;
  }

  bool submitted = false;
  AttemptStats stats;
  runAttempt(config, 2, &submitted, &stats);

  if (!submitted && config.fallbackEnabled) {
    std::cout << "Primary +2d failed. Trying +1d fallback...\n";
    runAttempt(config, 1, &submitted, &stats);
  }

  curl_global_cleanup();
  if (!submitted) {
    if (stats.totalTrials > 0 && stats.conflictTrials == stats.totalTrials) {
      std::cout << "All trials are conflicted. No request was submitted.\n";
      sendMacNotification("Octagon Booker", "All trials are conflicted. No request was submitted.");
      return 0;
    }
    std::cerr << "No reservation attempt succeeded.\n";
    return 1;
  }

  return 0;
}
