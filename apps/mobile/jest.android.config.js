// Keep Android module resolution and Platform.OS aligned with the shipped Android behavior.
module.exports = { ...require("./jest.config"), preset: "jest-expo/android" };
