module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    // The hoisted preset cannot detect expo-router installed in this workspace.
    // Enable its SDK 51 router transform explicitly for require.context.
    plugins: [require("babel-preset-expo/build/expo-router-plugin").expoRouterBabelPlugin],
  };
};
