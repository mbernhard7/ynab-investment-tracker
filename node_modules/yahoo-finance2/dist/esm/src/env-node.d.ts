/// <reference types="node" />
import { URLSearchParams } from "url";
import fetch from "node-fetch";
import type { RequestInfo, RequestInit, Response } from "node-fetch";
declare function fetchDevel(): Promise<(url: RequestInfo, init?: RequestInit | undefined) => Promise<Response>>;
declare const _default: {
    fetch: typeof fetch;
    fetchDevel: typeof fetchDevel;
    URLSearchParams: typeof URLSearchParams;
};
export default _default;
