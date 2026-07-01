cmake_minimum_required(VERSION 3.16)
project(octagon_booker_cpp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(CURL REQUIRED)

add_executable(octagon_booker_cpp main.cpp)
target_link_libraries(octagon_booker_cpp PRIVATE CURL::libcurl)
