const { productionApiUrl } = require("./config/api-url");
module.exports = ({ config }) => {
  const release = process.env.EAS_BUILD_PROFILE === "production" || process.env.APP_ENV === "production" || process.env.NODE_ENV === "production";
  const requestedUrl = process.env.USTAL_API_URL || config.extra?.apiBaseUrl;
  const apiBaseUrl = release ? productionApiUrl(requestedUrl) : requestedUrl;
  const projectId = process.env.EAS_PROJECT_ID || config.extra?.eas?.projectId;
  if (projectId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) throw new Error("EAS_PROJECT_ID must be the real UUID from the owner's Expo project");
  if (release && !projectId) throw new Error("Production requires EAS_PROJECT_ID from the owner's Expo project");
  return { ...config, extra: { ...config.extra, apiBaseUrl, release, ...(projectId ? { eas: { ...config.extra?.eas, projectId } } : {}) } };
};
