import { tool } from "ai";
import { createAgent } from "bot/agents";
import similarity from "utils/cosine-similarity";
import { getEnv } from "utils/env";
import { featureExtractor } from "utils/feature-extractor";
import { z } from "zod";

export const ltaAgent = createAgent({
  name: "lta_agent",
  description:
    "Interact with the Singapore LTA DataMall API to get bus arrival timings, " +
    "search bus stops, list bus services and bus routes." +
    "Returns the response from the agent in natural language you have to pass to the user.",
  parameters: z.object({
    instruction: z
      .string()
      .describe(
        "Natural language instruction for LTA bus operations. If user provided names use the names verbatim.",
      ),
  }),
  system: `
You are the LTA DataMall Agent, a specialized sub-agent for bus-related queries in Singapore on behalf of a higher-level language model.

Your mission:
  • Answer natural language questions about bus arrival times, stop information, service routes, and passenger volumes.
  • Enrich responses with helpful details like upcoming bus schedules, stop sequences, and ridership data.

Available tools:
  • get_bus_arrival_timings(stop_id, service_no?, accept?): Real-time next bus arrivals for a stop (and optional service).
  • find_bus_stops_by_name(query, accept?): Search bus stops by name or road semantically.
  • find_bus_stops_near_location(lat, lon, radius?, accept?): Find bus stops within a radius (km) of coordinates.
  • get_bus_services(service_no?, origin_code?, accept?): Retrieve service details for a specified route or origin stop.
  • get_bus_route_for_service(service_no, accept?): Obtain the stop sequence and schedule for a specific service.
  • get_passenger_volume_by_bus_stop(date?, accept?): Get tap-in/tap-out volumes for a bus stop (YYYYMM).

When invoking a tool, return only the JSON payload for the tool call. Do not include explanatory text or formatting.

Expand all abbreviations when answering back to your parent agent.
`,
  createTools: ({ ctx }) => ({
    get_bus_arrival_timings: tool({
      description: `Real-time Bus Arrival information for a queried Bus Stop including next 3 oncoming buses.
URL: https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival
Description: Returns real-time Bus Arrival information of Bus Services at a queried Bus Stop, including Est. Arrival Time, Est. Current Location, Est. Current Load.
Update Freq: 20 seconds

Request parameters:
- BusStopCode: Bus stop reference code (required)
- ServiceNo: Bus service number (optional)

Response attributes:
- ServiceNo: Bus service number (e.g. '15')
- Operator: Public Transport Operator code: SBST, SMRT, TTS, GAS
- NextBus, NextBus2, NextBus3: Objects with:
  - OriginCode: Reference code of the first bus stop where this bus started its service
  - DestinationCode: Reference code of the last bus stop where this bus will terminate its service
  - EstimatedArrival: Estimated arrival time in ISO format (e.g. '2024-08-14T16:41:48+08:00')
  - Monitored: 1 if estimated based on bus location, 0 if based on schedule
  - Latitude: Current estimated latitude of bus (e.g. '1.3154918333333334')
  - Longitude: Current estimated longitude of bus (e.g. '103.9059125')
  - VisitNumber: Ordinal visit count at this bus stop (e.g. '1')
  - Load: Current bus occupancy level: SEA (for Seats Available), SDA (for Standing Available), LSD (for Limited Standing)
  - Feature: WAB (Wheel-chair accessible) or blank
  - Type: Vehicle type: SD (for Single Deck), DD (for Double Deck), BD (for Bendy)
`,
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
      description: `Search for bus stops by name or road semantically.
Response attributes:
- BusStopCode: The unique 5-digit identifier for this physical bus stop (e.g. '01012')
- RoadName: The road on which this bus stop is located (e.g. 'Victoria St')
- Description: Landmarks next to the bus stop to aid in identifying this bus stop (e.g. 'Hotel Grand Pacific')
- Latitude: Location coordinates for this bus stop (e.g. 1.29685)
- Longitude: Location coordinates for this bus stop (e.g. 103.853)
- score: Similarity score between query and bus stop description (range 0-1)
`,
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

        const threshold = 0.3;
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
      description: `Retrieve bus service details filtered by service_no or origin_code.
Response attributes:
- ServiceNo: The bus service number (e.g. '107M')
- Operator: Operator for this bus service (e.g. 'SBST')
- Direction: The direction bus travels (1 or 2); loop services only have 1 direction
- Category: Category of the bus service (EXPRESS, FEEDER, INDUSTRIAL, TOWNLINK, TRUNK, etc.)
- OriginCode: Bus stop code for first bus stop (e.g. '64009')
- DestinationCode: Bus stop code for last bus stop (e.g. '64009')
- AM_Peak_Freq: Dispatch frequency during AM Peak (0630H-0830H) in minutes (e.g. '14-17')
- AM_Offpeak_Freq: Dispatch frequency during AM Off-Peak (0831H-1659H) in minutes (e.g. '10-16')
- PM_Peak_Freq: Dispatch frequency during PM Peak (1700H-1900H) in minutes (e.g. '12-15')
- PM_Offpeak_Freq: Dispatch frequency after PM Off-Peak (e.g. '12-15')
- LoopDesc: Loop location for loop services; empty if not a loop service (e.g. 'Raffles Blvd')`,
      parameters: z
        .object({
          service_no: z
            .string()
            .optional()
            .describe("Bus service number (ServiceNo), e.g. '107M'."),
          origin_code: z
            .string()
            .optional()
            .describe("Bus stop code to filter by origin stop, e.g. '64009'."),
          accept: z
            .enum(["application/json", "application/atom+xml"])
            .optional()
            .describe(
              "Response format: 'application/json' (default) or 'application/atom+xml' for XML",
            ),
        })
        .refine(
          (o) => !!(o.service_no || o.origin_code),
          "Either service_no or origin_code must be specified",
        ),
      async execute({ service_no, origin_code, accept }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const headers: Record<string, string> = { AccountKey: apiKey };
        if (accept) headers.Accept = accept;
        let skip = 0;
        const results: any[] = [];
        while (true) {
          const params = new URLSearchParams();
          params.append("$skip", skip.toString());
          const url = `https://datamall2.mytransport.sg/ltaodataservice/BusServices?${params}`;
          const resp = await fetch(url, { headers });
          if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(
              `Failed to fetch bus services: ${resp.status} ${txt}`,
            );
          }
          const body = await resp.json();
          console.log(body, `LTA bus data from get_bus_services skip=${skip}`);
          const page: any[] = Array.isArray(body.value) ? body.value : [];
          if (page.length === 0) break;
          const filtered = page.filter(
            (r) =>
              (service_no && r.ServiceNo === service_no) ||
              (origin_code && r.OriginCode === origin_code),
          );
          if (filtered.length) {
            results.push(...filtered);
            break;
          }
          skip += 500;
        }
        return results.map((r: any) => ({
          serviceNo: r.ServiceNo,
          operator: r.Operator,
          direction: r.Direction,
          category: r.Category,
          originCode: r.OriginCode,
          destinationCode: r.DestinationCode,
          amPeakFreq: r.AM_Peak_Freq,
          amOffpeakFreq: r.AM_Offpeak_Freq,
          pmPeakFreq: r.PM_Peak_Freq,
          pmOffpeakFreq: r.PM_Offpeak_Freq,
          loopDesc: r.LoopDesc,
        }));
      },
    }),

    get_bus_route_for_service: tool({
      description: `Get detailed route information for a single bus service (ServiceNo).
Response attributes:
- serviceNo: The bus service number (e.g. '107M')
- operator: Operator for this bus service (e.g. 'SBST')
- direction: The direction in which the bus travels (1 or 2); loop services only have 1 direction
- stopSequence: The i-th bus stop for this route (e.g. 28)
- busStopCode: The unique 5-digit identifier for this physical bus stop (e.g. '01219')
- distanceKm: Distance travelled by bus from starting location to this bus stop in kilometres (e.g. 10.3)
- weekdayFirstBus: Scheduled arrival of first bus on weekdays (e.g. '2025')
- weekdayLastBus: Scheduled arrival of last bus on weekdays (e.g. '2352')
- saturdayFirstBus: Scheduled arrival of first bus on Saturdays (e.g. '1427')
- saturdayLastBus: Scheduled arrival of last bus on Saturdays (e.g. '2349')
- sundayFirstBus: Scheduled arrival of first bus on Sundays (e.g. '0620')
- sundayLastBus: Scheduled arrival of last bus on Sundays (e.g. '2349')`,
      parameters: z.object({
        service_no: z
          .string()
          .describe("Bus service number (ServiceNo), e.g. '107M'."),
        accept: z
          .enum(["application/json", "application/atom+xml"])
          .optional()
          .describe(
            "Response format: 'application/json' (default) or 'application/atom+xml' for XML",
          ),
      }),
      async execute({ service_no, accept }) {
        const apiKey = getEnv("LTA_DATAMALL_API_KEY");
        const headers: Record<string, string> = { AccountKey: apiKey };
        if (accept) headers.Accept = accept;
        let skip = 0;
        const results: any[] = [];
        while (true) {
          const params = new URLSearchParams();
          params.append("$skip", skip.toString());
          const url = `https://datamall2.mytransport.sg/ltaodataservice/BusRoutes?${
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
          console.log(
            body,
            `LTA bus data from get_bus_route_for_service skip=${skip}`,
          );
          const page: any[] = Array.isArray(body.value) ? body.value : [];
          if (page.length === 0) break;
          const matches = page.filter((r) => r.ServiceNo === service_no);
          if (matches.length) {
            results.push(...matches);
            break;
          }
          skip += 500;
        }
        return results.map((r: any) => ({
          serviceNo: r.ServiceNo,
          operator: r.Operator,
          direction: r.Direction,
          stopSequence: r.StopSequence,
          busStopCode: r.BusStopCode,
          distanceKm: r.Distance,
          weekdayFirstBus: r.WD_FirstBus,
          weekdayLastBus: r.WD_LastBus,
          saturdayFirstBus: r.SAT_FirstBus,
          saturdayLastBus: r.SAT_LastBus,
          sundayFirstBus: r.SUN_FirstBus,
          sundayLastBus: r.SUN_LastBus,
        }));
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
