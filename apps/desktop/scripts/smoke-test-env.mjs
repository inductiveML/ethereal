export function makeSmokeEnvironment(environment) {
  const { VITE_DEV_SERVER_URL: _developmentServerUrl, ...productionEnvironment } = environment;
  return {
    ...productionEnvironment,
    ELECTRON_ENABLE_LOGGING: "1",
  };
}
