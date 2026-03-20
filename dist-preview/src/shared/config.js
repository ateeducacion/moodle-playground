// Use __APP_ROOT__ (injected by esbuild for bundled workers) or fall back
// to import.meta.url for unbundled browser module contexts.
const baseUrl =
  typeof __APP_ROOT__ !== "undefined"
    ? __APP_ROOT__
    : new URL("../../", import.meta.url).href;
const CONFIG_URL = new URL("playground.config.json", baseUrl);

let configPromise;

export async function loadPlaygroundConfig() {
  if (!configPromise) {
    configPromise = fetch(CONFIG_URL, { cache: "no-store" }).then(
      async (response) => {
        if (!response.ok) {
          throw new Error(
            `Unable to load playground config: ${response.status}`,
          );
        }

        return response.json();
      },
    );
  }

  return configPromise;
}

export function getDefaultRuntime(config) {
  return (
    config.runtimes.find((runtime) => runtime.default) || config.runtimes[0]
  );
}
