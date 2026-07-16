import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  LoadingManager,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  UnsignedByteType
} from "three";

export interface GltfAssetCacheConfig {
  maxResolvedEntries: number;
  preloadConcurrency: number;
  binaryPreloadConcurrency: number;
}

interface WarmOptions {
  priority?: "high" | "low";
}

function createFallbackTexture() {
  const texture = new DataTexture(
    new Uint8Array([222, 198, 167, 255]),
    1,
    1,
    RGBAFormat,
    UnsignedByteType
  );

  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.needsUpdate = true;

  return texture;
}

class ResilientTextureLoader extends TextureLoader {
  override load(
    url: string,
    onLoad?: (texture: Texture) => void,
    onProgress?: (event: ProgressEvent<EventTarget>) => void,
    _onError?: (event: unknown) => void
  ) {
    void _onError;

    return super.load(
      url,
      onLoad,
      onProgress,
      () => {
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[AR] Missing texture "${url}". Using fallback texture.`);
        }

        onLoad?.(createFallbackTexture());
      }
    );
  }
}

class GltfAssetCache {
  private readonly loadingManager = new LoadingManager();
  private readonly loader = new GLTFLoader(this.loadingManager);
  private readonly dracoLoader = new DRACOLoader();
  private readonly resolved = new Map<string, GLTF>();
  private readonly pending = new Map<string, Promise<GLTF>>();
  private readonly binaryResolved = new Set<string>();
  private readonly binaryPending = new Map<string, Promise<void>>();
  private readonly preloadQueue: string[] = [];
  private readonly preloadQueued = new Set<string>();
  private preloadActive = 0;
  private readonly binaryPreloadQueue: string[] = [];
  private readonly binaryPreloadQueued = new Set<string>();
  private binaryPreloadActive = 0;
  private config: GltfAssetCacheConfig = {
    maxResolvedEntries: 12,
    preloadConcurrency: 2,
    binaryPreloadConcurrency: 2
  };

  constructor() {
    if (typeof window !== "undefined") {
      this.loadingManager.addHandler(
        /\.(png|jpe?g|webp|avif)$/i,
        new ResilientTextureLoader(this.loadingManager)
      );
      this.dracoLoader.setDecoderPath("/draco/");
      this.dracoLoader.setDecoderConfig({ type: "wasm" });
      this.loader.setDRACOLoader(this.dracoLoader);
      this.dracoLoader.preload();
    }
  }

  configure(next: Partial<GltfAssetCacheConfig>) {
    this.config = {
      maxResolvedEntries:
        next.maxResolvedEntries !== undefined
          ? Math.max(2, Math.round(next.maxResolvedEntries))
          : this.config.maxResolvedEntries,
      preloadConcurrency:
        next.preloadConcurrency !== undefined
          ? Math.max(1, Math.round(next.preloadConcurrency))
          : this.config.preloadConcurrency,
      binaryPreloadConcurrency:
        next.binaryPreloadConcurrency !== undefined
          ? Math.max(1, Math.round(next.binaryPreloadConcurrency))
          : this.config.binaryPreloadConcurrency
    };

    this.evictToLimit();
    this.drainPreloadQueue();
    this.drainBinaryPreloadQueue();
  }

  getConfig() {
    return this.config;
  }

  private touchResolved(url: string, asset: GLTF) {
    this.resolved.delete(url);
    this.resolved.set(url, asset);
  }

  private evictToLimit() {
    while (this.resolved.size > this.config.maxResolvedEntries) {
      const oldestKey = this.resolved.keys().next().value as string | undefined;

      if (!oldestKey) {
        break;
      }

      this.resolved.delete(oldestKey);
    }
  }

  async load(url: string) {
    if (this.resolved.has(url)) {
      const cached = this.resolved.get(url)!;
      this.touchResolved(url, cached);
      return cached;
    }

    if (this.pending.has(url)) {
      return this.pending.get(url)!;
    }

    const request = this.loader
      .loadAsync(url)
      .then((asset) => {
        this.pending.delete(url);
        this.touchResolved(url, asset);
        this.evictToLimit();
        return asset;
      })
      .catch((error) => {
        this.pending.delete(url);
        this.resolved.delete(url);
        throw error;
      });

    this.pending.set(url, request);

    return request;
  }

  preload(url?: string, options?: WarmOptions) {
    if (!url || this.resolved.has(url) || this.pending.has(url)) {
      return;
    }

    if ((options?.priority ?? "low") === "high") {
      void this.load(url).catch(() => undefined);
      return;
    }

    if (this.preloadQueued.has(url)) {
      return;
    }

    this.preloadQueued.add(url);
    this.preloadQueue.push(url);
    this.drainPreloadQueue();
  }

  private drainPreloadQueue() {
    while (
      this.preloadActive < this.config.preloadConcurrency &&
      this.preloadQueue.length > 0
    ) {
      const next = this.preloadQueue.shift();

      if (!next) {
        break;
      }

      this.preloadQueued.delete(next);

      if (this.resolved.has(next) || this.pending.has(next)) {
        continue;
      }

      this.preloadActive += 1;

      void this.load(next)
        .catch(() => undefined)
        .finally(() => {
          this.preloadActive = Math.max(0, this.preloadActive - 1);
          this.drainPreloadQueue();
        });
    }
  }

  preloadMany(urls: string[], maxConcurrent = 2) {
    const queue = [...new Set(urls)].filter(Boolean);

    if (queue.length === 0) {
      return;
    }

    const parallel = Math.max(1, Math.min(maxConcurrent, queue.length));

    const worker = async () => {
      while (queue.length > 0) {
        const next = queue.shift();

        if (!next) {
          break;
        }

        try {
          await this.load(next);
        } catch {
          // Ignore warm-up failures; runtime loading still has its own fallback path.
        }
      }
    };

    void Promise.all(Array.from({ length: parallel }, () => worker()));
  }

  preloadBinary(url?: string, options?: WarmOptions) {
    if (
      !url ||
      typeof window === "undefined" ||
      this.binaryResolved.has(url) ||
      this.binaryPending.has(url)
    ) {
      return;
    }

    if ((options?.priority ?? "low") === "high") {
      this.startBinaryWarm(url);
      return;
    }

    if (this.binaryPreloadQueued.has(url)) {
      return;
    }

    this.binaryPreloadQueued.add(url);
    this.binaryPreloadQueue.push(url);
    this.drainBinaryPreloadQueue();
  }

  private startBinaryWarm(url: string) {
    const request = fetch(url, {
      cache: "force-cache",
      credentials: "same-origin"
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to warm binary asset: ${response.status}`);
        }

        await response.arrayBuffer();
        this.binaryResolved.add(url);
        this.binaryPending.delete(url);
      })
      .catch(() => {
        this.binaryPending.delete(url);
      });

    this.binaryPending.set(url, request);
  }

  private drainBinaryPreloadQueue() {
    while (
      this.binaryPreloadActive < this.config.binaryPreloadConcurrency &&
      this.binaryPreloadQueue.length > 0
    ) {
      const next = this.binaryPreloadQueue.shift();

      if (!next) {
        break;
      }

      this.binaryPreloadQueued.delete(next);

      if (this.binaryResolved.has(next) || this.binaryPending.has(next)) {
        continue;
      }

      this.binaryPreloadActive += 1;
      this.startBinaryWarm(next);

      void this.binaryPending.get(next)?.finally(() => {
        this.binaryPreloadActive = Math.max(0, this.binaryPreloadActive - 1);
        this.drainBinaryPreloadQueue();
      });
    }
  }

  preloadBinaryMany(urls: string[], maxConcurrent = 2) {
    const queue = [...new Set(urls)].filter(Boolean);

    if (queue.length === 0 || typeof window === "undefined") {
      return;
    }

    const parallel = Math.max(1, Math.min(maxConcurrent, queue.length));

    const worker = async () => {
      while (queue.length > 0) {
        const next = queue.shift();

        if (!next) {
          break;
        }

        this.preloadBinary(next, { priority: "low" });
        await this.binaryPending.get(next);
      }
    };

    void Promise.all(Array.from({ length: parallel }, () => worker()));
  }

  invalidate(url?: string) {
    if (!url) {
      this.resolved.clear();
      this.pending.clear();
      this.binaryResolved.clear();
      this.binaryPending.clear();
      this.preloadQueue.length = 0;
      this.preloadQueued.clear();
      this.binaryPreloadQueue.length = 0;
      this.binaryPreloadQueued.clear();
      return;
    }

    this.resolved.delete(url);
    this.pending.delete(url);
    this.binaryResolved.delete(url);
    this.binaryPending.delete(url);
    this.preloadQueued.delete(url);
    this.binaryPreloadQueued.delete(url);
  }
}

export const gltfAssetCache = new GltfAssetCache();
