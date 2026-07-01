export async function notify(config, message) {
  console.log(message);

  if (!config.telegramBotToken || !config.telegramChatId) {
    return;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: message
      })
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram notification failed: ${response.status} ${body}`);
  }
}