import { createAgent } from "bot/agents";
import { tool } from "ai";
import { getEnv } from "utils/env";
import logger from "bot/logger";
import { z } from "zod";

/**
 * ltaAgent: an agent that interacts with the LTA DataMall API
 * for Singapore bus timings, stops, services, and routes.
 */
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
  system: `You are the LTA bus sub-agent using the Singapore Land Transport Authority DataMall API.
Use these operations to answer queries about bus timings, stops, services, and routes:
- get_bus_arrival_timings(stop_id, service_no?): get real-time bus arrival info for a bus stop code and optional service number.
- find_bus_stops_by_name(query): search bus stops whose description or road name contains the query.
- find_bus_stops_near_location(lat, lon, radius?): find bus stops within radius (km) of the given coordinates (default radius 0.5 km).
- get_bus_services(): get detailed information of all bus services in operation.
- get_bus_routes(): get detailed route information (stop sequence and timings) for all bus services.
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
      }),
      async execute({ stop_id, service_no }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const params = new URLSearchParams();
        params.append("BusStopCode", stop_id);
        if (service_no) params.append("ServiceNo", service_no);
        const resp = await fetch(
          `https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival?${params}`,
          { headers: { AccountKey: apiKey } },
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
      }),
      async execute({ query }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const resp = await fetch(
          "https://datamall2.mytransport.sg/ltaodataservice/BusStops",
          { headers: { AccountKey: apiKey } },
        );
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(`Failed to fetch bus stops: ${resp.status} ${txt}`);
        }
        const body = await resp.json();
        logger.debug(body, "LTA bus stop data from find_bus_stops_by_name");

        const stops = Array.isArray(body.value) ? body.value : body;
        const q = query.toLowerCase();
        return stops
          .filter(
            (s: any) =>
              s.Description.toLowerCase().includes(q) ||
              s.RoadName.toLowerCase().includes(q),
          )
          .map((s: any) => ({
            BusStopCode: s.BusStopCode,
            RoadName: s.RoadName,
            Description: s.Description,
            Latitude: parseFloat(s.Latitude),
            Longitude: parseFloat(s.Longitude),
          }));
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
      }),
      async execute({ lat, lon, radius = 0.5 }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const resp = await fetch(
          "https://datamall2.mytransport.sg/ltaodataservice/BusStops",
          { headers: { AccountKey: apiKey } },
        );
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(`Failed to fetch bus stops: ${resp.status} ${txt}`);
        }
        const body = await resp.json();
        logger.debug(
          body,
          "LTA bus stop data from find_bus_stops_near_location",
        );

        const stops = Array.isArray(body.value) ? body.value : body;
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
        const results = stops
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
          .filter((s: any) => s.distance_km <= radius)
          .sort((a: any, b: any) => a.distance_km - b.distance_km);
        return results;
      },
    }),

    get_bus_services: tool({
      description:
        "Get detailed service information for all bus services in operation.",
      parameters: z.object({}),
      async execute() {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const resp = await fetch(
          "https://datamall2.mytransport.sg/ltaodataservice/BusServices",
          { headers: { AccountKey: apiKey } },
        );
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(
            `Failed to fetch bus services: ${resp.status} ${txt}`,
          );
        }
        const body = await resp.json();
        logger.debug(body, "LTA bus data from get_bus_services");
        return Array.isArray(body.value) ? body.value : body;
      },
    }),

    get_bus_routes: tool({
      description:
        "Get detailed route information for all bus services in operation.",
      parameters: z.object({}),
      async execute() {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const resp = await fetch(
          "https://datamall2.mytransport.sg/ltaodataservice/BusRoutes",
          { headers: { AccountKey: apiKey } },
        );
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(`Failed to fetch bus routes: ${resp.status} ${txt}`);
        }
        const body = await resp.json();
        logger.debug(body, "LTA bus data from get_bus_routes");
        return Array.isArray(body.value) ? body.value : body;
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
      }),
      async execute({ date }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const params = new URLSearchParams();
        if (date) params.append("Date", date);
        const url =
          "https://datamall2.mytransport.sg/ltaodataservice/PV/Bus" +
          (params.toString() ? `?${params}` : "");
        const resp = await fetch(url, { headers: { AccountKey: apiKey } });
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(
            `Failed to fetch passenger volume PV/Bus: ${resp.status} ${txt}`,
          );
        }
        return await resp.json();
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
      }),
      async execute({ date }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const params = new URLSearchParams();
        if (date) params.append("Date", date);
        const url =
          "https://datamall2.mytransport.sg/ltaodataservice/PV/ODBus" +
          (params.toString() ? `?${params}` : "");
        const resp = await fetch(url, { headers: { AccountKey: apiKey } });
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(`Failed to fetch PV/ODBus: ${resp.status} ${txt}`);
        }
        return await resp.json();
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
          .describe("YYYYMM for origin-destination train volume data (optional)"),
      }),
      async execute({ date }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const params = new URLSearchParams();
        if (date) params.append("Date", date);
        const url =
          "https://datamall2.mytransport.sg/ltaodataservice/PV/ODTrain" +
          (params.toString() ? `?${params}` : "");
        const resp = await fetch(url, { headers: { AccountKey: apiKey } });
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(`Failed to fetch PV/ODTrain: ${resp.status} ${txt}`);
        }
        return await resp.json();
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
      }),
      async execute({ date }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const params = new URLSearchParams();
        if (date) params.append("Date", date);
        const url =
          "https://datamall2.mytransport.sg/ltaodataservice/PV/Train" +
          (params.toString() ? `?${params}` : "");
        const resp = await fetch(url, { headers: { AccountKey: apiKey } });
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(`Failed to fetch PV/Train: ${resp.status} ${txt}`);
        }
        return await resp.json();
      },
    }),
  }),
});