export type Environment = Record<string, string | undefined>;
export type HeadersMap = Record<string, string>;
export interface PreparedRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: HeadersMap;
  body: string | null;
  timeoutMs: number;
}
export interface LoadedProfile {
  request: PreparedRequest;
  template: PreparedRequest;
  secrets: Array<[string, string]>;
}
export interface Failure {
  kind: 'service-error' | 'network-error' | 'timeout' | 'invalid-capture';
  message: string;
  code?: string;
}
export interface ResponseResult {
  status: number | null;
  headers: HeadersMap;
  body: string;
  durationMs: number;
  failure?: Failure;
}
export interface BodyBinding {marker:string;template:string;encoding:'json'|'raw'}
export interface Capture {
  bodyBindings?: BodyBinding[];
  remoteJsonFingerprint?: string|null;
  version: 1;
  createdAt: string;
  mode: 'native-get' | 'function-post';
  request: PreparedRequest;
  observedHeaders: HeadersMap | null;
  headerSource: 'microlink-context' | 'function-configured' | 'unavailable';
  remote: ResponseResult;
  service: ResponseResult;
  replayable: boolean;
  notes: string[];
}
