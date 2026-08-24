/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@ustal/database", "@ustal/domain", "@ustal/config", "@ustal/validation", "@ustal/queue"],
  webpack: (config) => {
    // Наши workspace-пакеты пишут внутренние relative-импорты в NodeNext-
    // стиле (`./env.js`, хотя физически файл `env.ts`) — так требует
    // moduleResolution: "NodeNext" в tsconfig.base.json, и так их резолвит
    // tsx/Node ESM-загрузчик у apps/api и apps/worker. Webpack по умолчанию
    // не подставляет .ts/.tsx за явно указанным .js — resolve.extensionAlias
    // это описанный Next.js/webpack способ научить его этому же правилу,
    // не трогая исходники пакетов.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
