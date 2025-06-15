import { createAISDKTools } from "@agentic/ai-sdk";
import { calculator } from "@agentic/calculator";
import { e2b } from "@agentic/e2b";
import { GoogleCustomSearchClient } from "@agentic/google-custom-search";
import { JinaClient } from "@agentic/jina";
import { WeatherClient } from "@agentic/weather";
import { getEnv } from "utils/env";

const weather = new WeatherClient({
  apiKey: getEnv("WEATHER_API_KEY"),
});

const googleCustomSearch = new GoogleCustomSearchClient();

const jina = new JinaClient();

export const agenticTools = createAISDKTools(
  calculator,
  e2b,
  weather,
  googleCustomSearch,
  jina,
);
