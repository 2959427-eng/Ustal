// Обёртка над app.json: позволяет указать локальный/тестовый API через USTAL_API_URL
// (например USTAL_API_URL=http://10.0.2.2:4000). Если переменная не задана — поведение
// идентично прежнему (apiBaseUrl берётся из app.json).
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    apiBaseUrl: process.env.USTAL_API_URL || config.extra?.apiBaseUrl,
  },
});
