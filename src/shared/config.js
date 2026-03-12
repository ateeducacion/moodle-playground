const CONFIG_URL = new URL("../../playground.config.json", import.meta.url);

let configPromise;

export async function loadPlaygroundConfig() {
  if (!configPromise) {
    configPromise = fetch(CONFIG_URL, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Unable to load playground config: ${response.status}`);
      }

      return response.json();
    });
  }

  return configPromise;
}

export function getDefaultRuntime(config) {
  return config.runtimes.find((runtime) => runtime.default) || config.runtimes[0];
}
