/**
 * Навигационные регрессии на реальном expo-router (renderRouter из expo-router/testing-library, jest-expo).
 * Остальные модульные тесты — vitest (*.test.ts); здесь только *.nav.tsx.
 */
module.exports = {
  preset: "jest-expo",
  testMatch: ["<rootDir>/navigation-tests/**/*.nav.tsx"],
  // В монорепо корневой react (18, админка) иначе подхватывается пакетами из корня (react-query) — одна копия React 19.
  moduleNameMapper: { "^react$": "<rootDir>/node_modules/react", "^react/(.*)$": "<rootDir>/node_modules/react/$1" },
};
