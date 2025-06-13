import { pipeline } from "@huggingface/transformers";
import { tool } from "ai";
import { createAgent } from "bot/agents";
import similarity from "utils/cosine-similarity";
import { getEnv } from "utils/env";
import { z } from "zod";

/**
 * ltaAgent: an agent that interacts with the LTA DataMall API
 * for Singapore bus timings, stops, services, and routes.
 */
const featureExtractor = await pipeline(
  "feature-extraction",
  "Xenova/all-MiniLM-L6-v2",
);

export const ltaAgent = createAgent({
  name: "lta_agent",
  description:
    "Interact with the Singapore LTA DataMall API to get bus arrival timings, " +
    "search bus stops, list bus services and bus routes.",
  parameters: z.object({
    instruction: z
      .string()
      .describe("Natural language instruction for LTA bus operations"),
  }),
  system: `You are the LTA DataMall sub-agent using the Singapore Land Transport Authority DataMall API.
All requests must be GET and include the AccountKey header.
To request XML instead of JSON, include an Accept header set to "application/atom+xml"; default is JSON.
Most endpoints return up to 500 records per call. Pagination is handled automatically, so no $skip parameter is exposed.
Use these operations to answer queries about bus arrival, stops, services, routes, and passenger volume:
- get_bus_arrival_timings(stop_id, service_no?, accept?): real-time bus arrival info for a stop code and optional service.
- find_bus_stops_by_name(query, accept?): semantically search bus stop names, automatically paging until relevant matches are found.
- find_bus_stops_near_location(lat, lon, radius?, accept?): search bus stops within radius (km) of coordinates.
- get_bus_services(accept?): detailed info of all bus services in operation.
- get_bus_routes(accept?): detailed route info (stop sequence and timings) for all bus services.
- get_passenger_volume_by_bus_stop(date?, accept?): tap-in/tap-out passenger volume by bus stop.
- get_passenger_volume_by_od_bus(date?, accept?): weekday/weekend trips between origin-destination bus stops.
- get_passenger_volume_by_od_train(date?, accept?): weekday/weekend trips between origin-destination train stations.
- get_passenger_volume_by_train(date?, accept?): tap-in/tap-out passenger volume by train station.
Always return only a valid tool call in JSON format without any additional text or explanation.`,
  createTools: (toolData) => ({
    get_bus_arrival_timings: tool({
      description:
        "Get real-time bus arrival information for a bus stop code and optional service number.",
      parameters: z.object({
        stop_id: z.string().describe("Bus stop code (BusStopCode)"),
        service_no: z
          .string()
          .optional()
          .describe("Bus service number (ServiceNo), optional"),
        accept: z
          .enum(["application/json", "application/atom+xml"])
          .optional()
          .describe(
            "Response format: 'application/json' (default) or 'application/atom+xml' for XML",
          ),
      }),
      async execute({ stop_id, service_no, accept }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const params = new URLSearchParams();
        params.append("BusStopCode", stop_id);
        if (service_no) params.append("ServiceNo", service_no);
        const headers: Record<string, string> = { AccountKey: apiKey };
        if (accept) headers.Accept = accept;
        const resp = await fetch(
          `https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival?${params}`,
          { headers },
        );
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(`Failed to fetch bus arrival: ${resp.status} ${txt}`);
        }
        return await resp.json();
      },
    }),

    find_bus_stops_by_name: tool({
      description:
        "Find bus stops whose description or road name contains a search string.",
      parameters: z.object({
        query: z.string().describe("Search string to filter bus stops"),
        accept: z
          .enum(["application/json", "application/atom+xml"])
          .optional()
          .describe(
            "Response format: 'application/json' (default) or 'application/atom+xml' for XML",
          ),
      }),
      async execute({ query, accept }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const headers: Record<string, string> = { AccountKey: apiKey };
        if (accept) headers.Accept = accept;

        // Encode query once
        const queryOutput = await featureExtractor([query], {
          pooling: "mean",
          normalize: true,
        });
        const queryEmbedding: number[] = queryOutput.tolist()[0]!;

        const threshold = 0.5;
        let skip = 0;
        const candidates: Array<{ stop: any; score: number }> = [];

        // Page through 500-record batches until we find a good match or exhaust data
        while (true) {
          const params = new URLSearchParams();
          if (skip) params.append("$skip", skip.toString());
          const url = `https://datamall2.mytransport.sg/ltaodataservice/BusStops${
            params.toString() ? `?${params}` : ""
          }`;
          const resp = await fetch(url, { headers });
          if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`Failed to fetch bus stops: ${resp.status} ${txt}`);
          }
          const body = await resp.json();
          const stops = Array.isArray(body.value) ? body.value : [];
          if (stops.length === 0) break;

          // Compute embeddings for this page of stop names
          const names = stops.map((s: any) => s.Description);
          const embOutput = await featureExtractor(names, {
            pooling: "mean",
            normalize: true,
          });
          const descEmbeddings: number[][] = embOutput.tolist();

          // Score each stop against query
          for (let i = 0; i < stops.length; i++) {
            const score = similarity(descEmbeddings[i]!, queryEmbedding) ?? 0;
            candidates.push({ stop: stops[i], score });
          }

          // If a strong match is found, stop paging
          const best = candidates.reduce(
            (a, b) => (b.score > a.score ? b : a),
            { stop: null, score: -1 },
          );
          if (best.score >= threshold) break;
          skip += 500;
        }

        // Return top 5 matches sorted by similarity
        return candidates
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map(({ stop, score }) => ({ ...stop, score }));
      },
    }),

    find_bus_stops_near_location: tool({
      description:
        "Find bus stops within a radius (km) of given latitude/longitude.",
      parameters: z.object({
        lat: z.number().describe("Latitude of the center point"),
        lon: z.number().describe("Longitude of the center point"),
        radius: z
          .number()
          .optional()
          .describe("Search radius in kilometers (default 0.5)"),
        accept: z
          .enum(["application/json", "application/atom+xml"])
          .optional()
          .describe(
            "Response format: 'application/json' (default) or 'application/atom+xml' for XML",
          ),
      }),
      async execute({ lat, lon, radius = 0.5, accept }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const headers: Record<string, string> = { AccountKey: apiKey };
        if (accept) headers.Accept = accept;
        let skip = 0;
        const results: Array<{
          BusStopCode: string;
          RoadName: string;
          Description: string;
          Latitude: number;
          Longitude: number;
          distance_km: number;
        }> = [];
        const toRad = (deg: number) => (deg * Math.PI) / 180;
        const haversine = (
          lat1: number,
          lon1: number,
          lat2: number,
          lon2: number,
        ) => {
          const R = 6371; // km
          const dLat = toRad(lat2 - lat1);
          const dLon = toRad(lon2 - lon1);
          const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) *
              Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) ** 2;
          return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
        };
        while (true) {
          const params = new URLSearchParams();
          params.append("$skip", skip.toString());
          const resp = await fetch(
            `https://datamall2.mytransport.sg/ltaodataservice/BusStops${
              params.toString() ? `?${params}` : ""
            }`,
            { headers },
          );
          if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`Failed to fetch bus stops: ${resp.status} ${txt}`);
          }
          const body = await resp.json();
          const stops = Array.isArray(body.value) ? body.value : body;
          if (stops.length === 0) break;
          const pageResults = stops
            .map((s: any) => {
              const lat2 = parseFloat(s.Latitude);
              const lon2 = parseFloat(s.Longitude);
              const distance_km = haversine(lat, lon, lat2, lon2);
              return {
                BusStopCode: s.BusStopCode,
                RoadName: s.RoadName,
                Description: s.Description,
                Latitude: lat2,
                Longitude: lon2,
                distance_km,
              };
            })
            .filter((s: any) => s.distance_km <= radius);
          results.push(...pageResults);
          skip += 500;
        }
        return results.sort((a, b) => a.distance_km - b.distance_km);
      },
    }),

    get_bus_services: tool({
      description:
        "Get detailed service information for all bus services in operation.",
      parameters: z.object({
        accept: z
          .enum(["application/json", "application/atom+xml"])
          .optional()
          .describe(
            "Response format: 'application/json' (default) or 'application/atom+xml' for XML",
          ),
      }),
      async execute({ accept }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const headers: Record<string, string> = { AccountKey: apiKey };
        if (accept) headers.Accept = accept;
        let skip = 0;
        const results: any[] = [];
        while (true) {
          const params = new URLSearchParams();
          params.append("$skip", skip.toString());
          const url = `https://datamall2.mytransport.sg/ltaodataservice/BusServices${
            params.toString() ? `?${params}` : ""
          }`;
          const resp = await fetch(url, { headers });
          if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(
              `Failed to fetch bus services: ${resp.status} ${txt}`,
            );
          }
          const body = await resp.json();
          console.log(body, `LTA bus data from get_bus_services skip=${skip}`);
          const page = Array.isArray(body.value) ? body.value : [];
          if (page.length === 0) break;
          results.push(...page);
          skip += 500;
        }
        return results;
      },
    }),

    get_bus_routes: tool({
      description:
        "Get detailed route information for all bus services in operation.",
      parameters: z.object({
        accept: z
          .enum(["application/json", "application/atom+xml"])
          .optional()
          .describe(
            "Response format: 'application/json' (default) or 'application/atom+xml' for XML",
          ),
      }),
      async execute({ accept }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const headers: Record<string, string> = { AccountKey: apiKey };
        if (accept) headers.Accept = accept;
        let skip = 0;
        const results: any[] = [];
        while (true) {
          const params = new URLSearchParams();
          params.append("$skip", skip.toString());
          const url = `https://datamall2.mytransport.sg/ltaodataservice/BusRoutes${
            params.toString() ? `?${params}` : ""
          }`;
          const resp = await fetch(url, { headers });
          if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(
              `Failed to fetch bus routes: ${resp.status} ${txt}`,
            );
          }
          const body = await resp.json();
          console.log(body, `LTA bus data from get_bus_routes skip=${skip}`);
          const page = Array.isArray(body.value) ? body.value : [];
          if (page.length === 0) break;
          results.push(...page);
          skip += 500;
        }
        return results;
      },
    }),

    /**
     * Fetch passenger volume by bus stop from LTA DataMall PV/Bus.
     * Optionally filter by date (YYYYMM).
     */
    get_passenger_volume_by_bus_stop: tool({
      description:
        "Get tap-in/tap-out passenger volume by bus stop. Optionally specify Date=YYYYMM to filter.",
      parameters: z.object({
        date: z
          .string()
          .optional()
          .describe("YYYYMM for passenger volume data (optional)"),
        accept: z
          .enum(["application/json", "application/atom+xml"])
          .optional()
          .describe(
            "Response format: 'application/json' (default) or 'application/atom+xml' for XML",
          ),
      }),
      async execute({ date, accept }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const headers: Record<string, string> = { AccountKey: apiKey };
        if (accept) headers.Accept = accept;
        let skip = 0;
        const results: any[] = [];
        while (true) {
          const params = new URLSearchParams();
          if (date) params.append("Date", date);
          params.append("$skip", skip.toString());
          const url = `https://datamall2.mytransport.sg/ltaodataservice/PV/Bus${
            params.toString() ? `?${params}` : ""
          }`;
          const resp = await fetch(url, { headers });
          if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(
              `Failed to fetch passenger volume PV/Bus: ${resp.status} ${txt}`,
            );
          }
          const body = await resp.json();
          const page = Array.isArray(body.value) ? body.value : [];
          if (page.length === 0) break;
          results.push(...page);
          skip += 500;
        }
        return results;
      },
    }),

    /**
     * Fetch passenger volume by origin-destination for bus stops (PV/ODBus).
     * Optionally filter by date (YYYYMM).
     */
    get_passenger_volume_by_od_bus: tool({
      description:
        "Get number of trips by weekdays and weekends from origin to destination bus stops. Optionally specify Date=YYYYMM.",
      parameters: z.object({
        date: z
          .string()
          .optional()
          .describe("YYYYMM for origin-destination bus volume data (optional)"),
        accept: z
          .enum(["application/json", "application/atom+xml"])
          .optional()
          .describe(
            "Response format: 'application/json' (default) or 'application/atom+xml' for XML",
          ),
      }),
      async execute({ date, accept }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const headers: Record<string, string> = { AccountKey: apiKey };
        if (accept) headers.Accept = accept;
        let skip = 0;
        const results: any[] = [];
        while (true) {
          const params = new URLSearchParams();
          if (date) params.append("Date", date);
          params.append("$skip", skip.toString());
          const url = `https://datamall2.mytransport.sg/ltaodataservice/PV/ODBus${
            params.toString() ? `?${params}` : ""
          }`;
          const resp = await fetch(url, { headers });
          if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`Failed to fetch PV/ODBus: ${resp.status} ${txt}`);
          }
          const body = await resp.json();
          const page = Array.isArray(body.value) ? body.value : [];
          if (page.length === 0) break;
          results.push(...page);
          skip += 500;
        }
        return results;
      },
    }),

    /**
     * Fetch passenger volume by origin-destination for train stations (PV/ODTrain).
     * Optionally filter by date (YYYYMM).
     */
    get_passenger_volume_by_od_train: tool({
      description:
        "Get number of trips by weekdays and weekends from origin to destination train stations. Optionally specify Date=YYYYMM.",
      parameters: z.object({
        date: z
          .string()
          .optional()
          .describe(
            "YYYYMM for origin-destination train volume data (optional)",
          ),
        accept: z
          .enum(["application/json", "application/atom+xml"])
          .optional()
          .describe(
            "Response format: 'application/json' (default) or 'application/atom+xml' for XML",
          ),
      }),
      async execute({ date, accept }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const headers: Record<string, string> = { AccountKey: apiKey };
        if (accept) headers.Accept = accept;
        let skip = 0;
        const results: any[] = [];
        while (true) {
          const params = new URLSearchParams();
          if (date) params.append("Date", date);
          params.append("$skip", skip.toString());
          const url = `https://datamall2.mytransport.sg/ltaodataservice/PV/ODTrain${
            params.toString() ? `?${params}` : ""
          }`;
          const resp = await fetch(url, { headers });
          if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(
              `Failed to fetch PV/ODTrain: ${resp.status} ${txt}`,
            );
          }
          const body = await resp.json();
          const page = Array.isArray(body.value) ? body.value : [];
          if (page.length === 0) break;
          results.push(...page);
          skip += 500;
        }
        return results;
      },
    }),

    /**
     * Fetch passenger volume by train station (PV/Train).
     * Optionally filter by date (YYYYMM).
     */
    get_passenger_volume_by_train: tool({
      description:
        "Get tap-in/tap-out passenger volume by train station. Optionally specify Date=YYYYMM.",
      parameters: z.object({
        date: z
          .string()
          .optional()
          .describe("YYYYMM for train station volume data (optional)"),
        accept: z
          .enum(["application/json", "application/atom+xml"])
          .optional()
          .describe(
            "Response format: 'application/json' (default) or 'application/atom+xml' for XML",
          ),
      }),
      async execute({ date, accept }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const headers: Record<string, string> = { AccountKey: apiKey };
        if (accept) headers.Accept = accept;
        let skip = 0;
        const results: any[] = [];
        while (true) {
          const params = new URLSearchParams();
          if (date) params.append("Date", date);
          params.append("$skip", skip.toString());
          const url = `https://datamall2.mytransport.sg/ltaodataservice/PV/Train${
            params.toString() ? `?${params}` : ""
          }`;
          const resp = await fetch(url, { headers });
          if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`Failed to fetch PV/Train: ${resp.status} ${txt}`);
          }
          const body = await resp.json();
          const page = Array.isArray(body.value) ? body.value : [];
          if (page.length === 0) break;
          results.push(...page);
          skip += 500;
        }
        return results;
      },
    }),
  }),
});
