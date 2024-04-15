export interface Root {
  kind: string;
  url: Url;
  queries: Queries;
  context: Context;
  searchInformation: SearchInformation;
  items: Item[];
}

export interface Url {
  type: string;
  template: string;
}

export interface Queries {
  request: Request[];
  nextPage: NextPage[];
}

export interface Request {
  title: string;
  totalResults: string;
  searchTerms: string;
  count: number;
  startIndex: number;
  inputEncoding: string;
  outputEncoding: string;
  safe: string;
  cx: string;
}

export interface NextPage {
  title: string;
  totalResults: string;
  searchTerms: string;
  count: number;
  startIndex: number;
  inputEncoding: string;
  outputEncoding: string;
  safe: string;
  cx: string;
}

export interface Context {
  title: string;
}

export interface SearchInformation {
  searchTime: number;
  formattedSearchTime: string;
  totalResults: string;
  formattedTotalResults: string;
}

export interface Item {
  kind: string;
  title: string;
  htmlTitle: string;
  link: string;
  displayLink: string;
  snippet: string;
  htmlSnippet: string;
  cacheId?: string;
  formattedUrl: string;
  htmlFormattedUrl: string;
  pagemap: Pagemap;
}

export interface Pagemap {
  cse_thumbnail?: CseThumbnail[];
  metatags: Metatag[];
  cse_image?: CseImage[];
}

export interface CseThumbnail {
  src: string;
  width: string;
  height: string;
}

export interface Metatag {
  referrer?: string;
  viewport: string;
  google?: string;
  "format-detection"?: string;
  "og:image"?: string;
  "theme-color"?: string;
  "og:type"?: string;
  "twitter:card"?: string;
  "twitter:title"?: string;
  "og:site_name"?: string;
  "twitter:url"?: string;
  "og:title"?: string;
  "og:description"?: string;
  "twitter:image"?: string;
  "track-metadata-page_publishing_platform"?: string;
  "track-metadata-page_hosting_platform"?: string;
  "twitter:site"?: string;
  "twitter:description"?: string;
  "track-metadata-page_template"?: string;
  "og:url"?: string;
  "application-name"?: string;
  "apple-mobile-web-app-status-bar-style"?: string;
  "msapplication-tap-highlight"?: string;
  "apple-mobile-web-app-capable"?: string;
  "apple-mobile-web-app-title"?: string;
  "mobile-web-app-capable"?: string;
  iseom?: string;
  iseea?: string;
  "og:image:width"?: string;
  "og:image:height"?: string;
  "google:search-sre-monitor"?: string;
}

export interface CseImage {
  src: string;
}
