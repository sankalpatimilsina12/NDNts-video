import { Endpoint } from "@ndn/endpoint";
import { FwHint, Name } from "@ndn/packet";
import { retrieveMetadata } from "@ndn/rdr";
import { discoverVersion, fetch, RttEstimator, TcpCubic } from "@ndn/segmented-object";
import { assert } from "@ndn/util";
import hirestime from "hirestime";
import * as log from "loglevel";
import DefaultMap from "mnemonist/default-map.js";
import PQueue from "p-queue";
import shaka from "shaka-player";

import { sendBeacon } from "./connect.js";

/** @type {Array<[Name, FwHint]>} */
const fwHints = [];

/**
 * Update forwarding hint mapping.
 * @param {Record<string, string> | undefined} m
 */
export function updateFwHints(m = {}) {
  fwHints.splice(0, Infinity);
  for (const [prefix, fh] of Object.entries(m)) {
    fwHints.push([new Name(prefix), new FwHint(fh)]);
  }
  fwHints.sort((a, b) => b[0].length - a[0].length);
}

/**
 * Determine forwarding hint for Interest.
 * @param {Name} name
 * @returns {import("@ndn/packet").Interest.ModifyFields | undefined}
 */
function findFwHint(name) {
  for (const [prefix, fwHint] of fwHints) {
    if (prefix.isPrefixOf(name)) {
      return { fwHint };
    }
  }
  return undefined;
}

const getNow = hirestime();

class VideoFetcher {
  constructor() {
    /** @type {boolean | undefined} */
    this.perFileMetadata = undefined;
    /** @type {import("@ndn/packet").Component | undefined} */
    this.versionComponent = undefined;
    this.queue = new PQueue({ concurrency: 4 });
    this.rtte = new RttEstimator({ maxRto: 10000 });
    this.ca = new TcpCubic({ c: 0.1 });
    this.estimatedCounts = new DefaultMap(() => 5);
  }
}

class FileFetcher {
  /**
   * @param {VideoFetcher} vf
   * @param {string} uri
   * @param {unknown} requestType
   */
  constructor(vf, uri, requestType) {
    this.vf = vf;
    this.uri = uri;
    this.requestType = requestType;
    this.name = new Name(uri.replace(/^ndn:/, ""));
    this.estimatedCountKey = this.name.getPrefix(-2).valueHex;

    this.abort = new AbortController();
    this.endpoint = new Endpoint({
      modifyInterest: findFwHint(this.name),
      retx: 10,
      signal: this.abort.signal,
    });

    /** @type {Name | undefined} */
    this.versioned = undefined;
  }

  get estimatedFinalSegNum() {
    return this.vf.estimatedCounts.get(this.estimatedCountKey);
  }

  set estimatedFinalSegNum(value) {
    this.vf.estimatedCounts.set(this.estimatedCountKey, value);
  }

  async discoverConvention() {
    const result = await Promise.race([
      discoverVersion(this.name, {
        endpoint: this.endpoint,
      }),
      retrieveMetadata(this.name, {
        endpoint: this.endpoint,
      }),
    ]);
    if (result instanceof Name) {
      this.vf.perFileMetadata = false;
      this.vf.versionComponent = result.get(-1);
      this.versioned = result;
      log.debug(`NdnPlugin(${this.name}) convention version=${this.vf.versionComponent.toString()}`);
    } else {
      this.vf.perFileMetadata = true;
      this.vf.versionComponent = undefined;
      this.versioned = result.name;
      log.debug(`NdnPlugin(${this.name}) convention perFileMetadata`);
    }
  }

  async discoverVersion() {
    if (this.versioned) {
      return;
    }

    if (this.vf.perFileMetadata) {
      this.versioned = (await retrieveMetadata(this.name, {
        endpoint: this.endpoint,
      })).name;
    } else {
      assert(this.vf.versionComponent);
      this.versioned = this.name.append(this.vf.versionComponent);
    }
  }

  async download() {
    const t0 = getNow();
    const result = fetch(this.versioned, {
      endpoint: this.endpoint,
      rtte: this.vf.rtte,
      ca: this.vf.ca,
      retxLimit: 4,
      estimatedFinalSegNum: this.estimatedFinalSegNum,
    });
    const payload = await result;

    const timeMs = getNow() - t0;
    this.estimatedCounts = result.count;
    log.debug(`NdnPlugin(${this.name}) download rtt=${Math.round(timeMs)} count=${result.count}`);
    sendBeacon({
      a: "F",
      n: `${this.name}`,
      d: Math.round(timeMs),
      sRtt: Math.round(this.vf.rtte.sRtt),
      rto: Math.round(this.vf.rtte.rto),
      cwnd: Math.round(this.vf.ca.cwnd),
    });
    return {
      uri: this.uri,
      originalUri: this.uri,
      data: payload,
      headers: {},
      timeMs,
    };
  }

  /**
   * @param {Error} err
   */
  handleError(err) {
    if (this.abort.signal.aborted) {
      log.debug(`NdnPlugin(${this.name}) aborted`);
      return shaka.util.AbortableOperation.aborted();
    }
    log.warn(`NdnPlugin(${this.name}) error ${err}`);
    sendBeacon({
      a: "E",
      n: `${this.name}`,
      err: err.toString(),
    });
    throw new shaka.util.Error(
      shaka.util.Error.Severity.RECOVERABLE,
      shaka.util.Error.Category.NETWORK,
      shaka.util.Error.Code.BAD_HTTP_STATUS,
      this.uri, 503, null, {}, this.requestType);
  }
}

/** @type {VideoFetcher} */
let vf;

/** shaka.extern.SchemePlugin for ndn: scheme. */
export function NdnPlugin(uri, request, requestType) {
  const ff = new FileFetcher(vf, uri, requestType);
  log.debug(`NdnPlugin(${ff.name}) enqueue queue-size=${vf.queue.size}`);
  const t0 = getNow();
  return new shaka.util.AbortableOperation(vf.queue.add(async () => {
    log.debug(`NdnPlugin(${ff.name}) dequeue waited=${getNow() - t0}`);
    try {
      if (vf.perFileMetadata === undefined) {
        await ff.discoverConvention();
      }
      await ff.discoverVersion();
      return await ff.download();
    } catch (err) {
      ff.handleError(err);
    }
  }), () => ff.abort.abort());
}

NdnPlugin.reset = () => {
  vf = new VideoFetcher();
};

/** @returns {Pick<VideoFetcher, "queue"|"rtte"|"ca">} */
NdnPlugin.getInternals = () => vf;

NdnPlugin.reset();
