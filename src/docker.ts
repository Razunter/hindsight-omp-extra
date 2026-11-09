import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { SHM_SIZE_BYTES, type HindsightSettings } from "./runtime-config";

const DOCKER_TIMEOUT = 8_000;
export const INSTALLATION_LABEL = "io.github.razunter.hindsight-omp.installation";
export const CONFIG_LABEL = "io.github.razunter.hindsight-omp.config";
export const DERIVATIVE_LABEL = "io.github.razunter.hindsight-omp.derivative";
export const BASE_LABEL = "io.github.razunter.hindsight-omp.base";
const BUILD_TIMEOUT = 2 * 60 * 60 * 1000;
const PYTHON = "/app/api/.venv/bin/python";

/**
 * Adapted from Hindsight's docker/docker-compose/cuda/Dockerfile: the CUDA wheel of the base's own torch version
 * replaces the CPU wheel, and the build fails instead of letting the resolver change any other installed package.
 * Unlike the official recipe it also installs a C compiler: on CUDA, PyTorch JIT-compiles Triton kernels for some
 * local models (ModernBERT rerankers) and otherwise fails with "Failed to find C compiler".
 */
const CUDA_DOCKERFILE = `ARG BASE
FROM \${BASE}
ARG PYTORCH_CUDA_FLAVOR=cu126
ARG PYTORCH_CUDA_INDEX=https://download.pytorch.org/whl/cu126
USER root
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
USER hindsight
RUN set -e; \\
    TORCH_BASE_VERSION=$(${PYTHON} -c 'import torch; print(torch.__version__.split("+", 1)[0])'); \\
    uv pip freeze --python ${PYTHON} | grep -v '^torch==' | sort > /tmp/hindsight-before; \\
    uv pip install --python ${PYTHON} --no-cache --index "$PYTORCH_CUDA_INDEX" "torch==\${TORCH_BASE_VERSION}+\${PYTORCH_CUDA_FLAVOR}"; \\
    uv pip check --python ${PYTHON}; \\
    uv pip freeze --python ${PYTHON} | sort > /tmp/hindsight-after; \\
    changed=$(comm -23 /tmp/hindsight-before /tmp/hindsight-after); \\
    rm /tmp/hindsight-before /tmp/hindsight-after; \\
    if [ -n "$changed" ]; then echo "CUDA PyTorch would change other packages: $changed"; exit 1; fi; \\
    ${PYTHON} -c 'import torch; assert torch.version.cuda, "CUDA-enabled PyTorch wheel was not installed"; print(f"PyTorch CUDA runtime: {torch.version.cuda}")'
`;
/** Identifies the recipe a derivative was built with, so a changed recipe rebuilds instead of reusing an old image. */
export const CUDA_RECIPE = "cuda-" + new Bun.CryptoHasher("sha256").update(CUDA_DOCKERFILE).digest("hex").slice(0, 12);

/**
 * Run a docker command with an abort timeout, draining both pipes.
 * On abort/kill, exitCode is null.
 */
export async function docker(
    args: string[],
    timeout = DOCKER_TIMEOUT,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["docker", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(timeout),
    });
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { exitCode: proc.exitCode, stdout, stderr };
}

export async function dockerAvailable(): Promise<boolean> {
    return (await docker(["version", "--format", "{{.Server.Version}}"], 5_000)).exitCode === 0;
}

export interface ImageInfo { id: string; tags: string[]; digests: string[]; labels: Record<string, string> }

/** Locally cached image metadata, or undefined when Docker confirms it is not cached; registry digests come from RepoDigests, never from the image ID. */
export async function inspectImage(reference: string): Promise<ImageInfo | undefined> {
    const result = await docker(["image", "inspect", "--format", "{{json .}}", reference]);
    if (result.exitCode !== 0) {
        if (/No such image/i.test(result.stderr)) return undefined;
        throw new Error("Hindsight: Docker could not inspect a local image; check that Docker is running and accessible");
    }
    const image = JSON.parse(result.stdout);
    if (!/^sha256:[a-f0-9]{64}$/.test(image.Id) || !Array.isArray(image.RepoDigests ?? []) || !Array.isArray(image.RepoTags ?? [])) throw new Error("Invalid image metadata");
    // The containerd image store lists a digest-pulled image's `repo@sha256:...` reference in RepoTags; it is not a tag.
    const tags = (image.RepoTags ?? []).filter((entry: string) => !entry.includes("@"));
    return { id: image.Id, tags, digests: (image.RepoDigests ?? []).map((entry: string) => entry.slice(entry.indexOf("@") + 1)), labels: image.Config?.Labels ?? {} };
}

/**
 * Remove image `id` by ID unless `protect` claims it or a container, running or stopped, uses it. Never forced and never
 * prunes parents, so a tag or container added after this check makes Docker refuse. "gone" means it is no longer cached.
 */
export async function removeImage(id: string, protect: (image: ImageInfo) => boolean): Promise<"gone" | "kept" | "failed"> {
    let image: ImageInfo | undefined;
    try { image = await inspectImage(id); }
    catch { return "failed"; }
    if (!image) return "gone";
    if (protect(image)) return "kept";
    const users = await docker(["ps", "--all", "--quiet", "--filter", "ancestor=" + id]);
    if (users.exitCode !== 0) return "failed";
    if (users.stdout.trim()) return "kept";
    return (await docker(["image", "rm", "--no-prune", id])).exitCode === 0 ? "gone" : "failed";
}

const isDigest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
type Descriptor = { digest?: unknown; platform?: { os?: unknown; architecture?: unknown } };
const PLATFORM_ARCHITECTURE: Partial<Record<string, string>> = { x64: "amd64", arm64: "arm64" };

/**
 * Registry manifest digests of `reference` for linux on this host's architecture, read with buildx without
 * downloading layers. Docker's own credential store authenticates; registry output never leaves this function.
 * Returns "unsupported" when Buildx is missing and undefined for any other failure.
 */
export async function inspectUpstream(reference: string): Promise<{ digest: string; indexDigest?: string } | "unsupported" | undefined> {
    const result = await docker(["buildx", "imagetools", "inspect", reference, "--format", "{{json .Manifest}}"], 60_000);
    if (result.exitCode !== 0) return (await docker(["buildx", "version"])).exitCode === 0 ? undefined : "unsupported";
    try {
        const manifest: Descriptor & { manifests?: unknown } = JSON.parse(result.stdout);
        if (!Array.isArray(manifest.manifests)) return isDigest(manifest.digest) ? { digest: manifest.digest } : undefined;
        const platform = (manifest.manifests as Descriptor[]).find(entry => entry?.platform?.os === "linux" && entry.platform.architecture === PLATFORM_ARCHITECTURE[process.arch]);
        return isDigest(manifest.digest) && platform && isDigest(platform.digest) ? { digest: platform.digest, indexDigest: manifest.digest } : undefined;
    } catch {
        return undefined;
    }
}

export interface ContainerInfo { id: string; imageId: string; running: boolean; labels: Record<string, string>; gpu: boolean }

export async function inspectContainer(name: string): Promise<ContainerInfo | undefined> {
    const result = await docker(["container", "inspect", "--format", "{{json .}}", name]);
    if (result.exitCode !== 0) return undefined;
    const container = JSON.parse(result.stdout);
    const gpu = (container.HostConfig?.DeviceRequests ?? []).some((request: { Capabilities?: string[][] }) => request.Capabilities?.some(set => set.includes("gpu")));
    return { id: String(container.Id), imageId: String(container.Image), running: container.State?.Running === true, labels: container.Config?.Labels ?? {}, gpu };
}

/** Run `use` with the settings' environment in a 0600 file that is removed afterwards; credentials never travel as arguments. */
async function withEnvironmentFile<T>(settings: HindsightSettings, use: (file: string) => Promise<T>): Promise<T> {
    const environmentDirectory = fs.mkdtempSync(path.join(tmpdir(), "hindsight-docker-"));
    try {
        const environmentFile = path.join(environmentDirectory, "env");
        fs.writeFileSync(environmentFile, Object.entries(settings.env).map(([key, value]) => `${key}=${value}`).join("\n"), { flag: "wx", mode: 0o600 });
        return await use(environmentFile);
    } finally {
        fs.rmSync(environmentDirectory, { recursive: true, force: true });
    }
}

/** Create and start the managed container from an image ID. */
export async function runManagedContainer(settings: HindsightSettings, imageId: string, installationId: string): Promise<boolean> {
    return withEnvironmentFile(settings, async environmentFile => {
        const bindAddress = settings.bindAddress.includes(":") ? "[" + settings.bindAddress + "]" : settings.bindAddress;
        const run = await docker([
            "run", "-d", "--pull", "never",
            "--name", settings.containerName,
            "--restart", "unless-stopped",
            "--shm-size", String(SHM_SIZE_BYTES),
            ...(settings.gpu ? ["--gpus", "all"] : []),
            "--label", `${INSTALLATION_LABEL}=${installationId}`,
            "--label", `${CONFIG_LABEL}=${settings.configDigest}`,
            "-p", `${bindAddress}:${settings.apiPort}:${settings.env.HINDSIGHT_API_PORT ?? "8888"}`,
            "-p", `${bindAddress}:${settings.uiPort}:${settings.env.HINDSIGHT_CP_PORT ?? "9999"}`,
            "--env-file", environmentFile,
            "-v", `${settings.volumeName}:/home/hindsight/.pg0`,
            ...(settings.codexAuthDir ? ["-v", settings.codexAuthDir + ":/home/hindsight/.codex:rw"] : []),
            imageId,
        ], 60_000);
        return run.exitCode === 0;
    });
}

/**
 * Build the CUDA derivative of the immutable upstream `base` (`repo@digest`) from a context holding only the
 * generated Dockerfile, so no provider file, credential or agent state can reach a layer or build argument.
 * Build output is drained but never logged: it can echo registry errors.
 */
export async function buildCudaDerivative(base: string, tag: string, installationId: string): Promise<boolean> {
    const context = fs.mkdtempSync(path.join(tmpdir(), "hindsight-cuda-"));
    try {
        fs.writeFileSync(path.join(context, "Dockerfile"), CUDA_DOCKERFILE);
        return (await docker([
            "build", "--build-arg", `BASE=${base}`, "--tag", tag,
            "--label", `${INSTALLATION_LABEL}=${installationId}`,
            "--label", `${DERIVATIVE_LABEL}=${CUDA_RECIPE}`,
            "--label", `${BASE_LABEL}=${base}`,
            context,
        ], BUILD_TIMEOUT)).exitCode === 0;
    } finally {
        fs.rmSync(context, { recursive: true, force: true });
    }
}

/**
 * The GPU inference probe, run with the configured environment. For each model kind named in argv ("embeddings",
 * "reranker"; only applicable local models, so no remote provider is contacted) it builds the provider with Hindsight's
 * own factory, initializes it and runs one inference. Prints one JSON line: kind -> devices of its local backends, with
 * Hindsight's split-embeddings and failover-reranker wrappers unwrapped; a backend without a device reports null.
 */
const GPU_INFERENCE_PROBE = `
import asyncio, json, sys

def devices(model):
    kind = type(model).__name__
    inner = [model.query, model.passage] if kind == "SplitEmbeddings" else list(model._members) if kind == "MultiCrossEncoder" else None
    return [device for child in inner for device in devices(child)] if inner is not None else [getattr(model, "_device_type", None)]

async def main():
    text = "hindsight-omp readiness probe"
    report = {}
    if "embeddings" in sys.argv[1:]:
        from hindsight_api.engine.embeddings import create_embeddings_from_env
        model = create_embeddings_from_env()
        await model.initialize()
        await model.encode([text])
        report["embeddings"] = devices(model)
    if "reranker" in sys.argv[1:]:
        from hindsight_api.engine.cross_encoder import create_cross_encoder_from_env
        model = create_cross_encoder_from_env()
        await model.initialize()
        await model.predict([(text, text)])
        report["reranker"] = devices(model)
    print(json.dumps(report))

asyncio.run(main())
`;

/** Run the probe after `command`; the devices by kind, or undefined when it failed or printed nothing usable. */
async function probe(command: string[], kinds: string[]): Promise<Record<string, unknown> | undefined> {
    const result = await docker([...command, "-c", GPU_INFERENCE_PROBE, ...kinds], 5 * 60_000);
    if (result.exitCode !== 0) return undefined;
    try { return JSON.parse(result.stdout.trim().split("\n").at(-1)!); }
    catch { return undefined; }
}

/** Before cutover: probe a throwaway `--gpus all` container of `imageId` with the configured environment, no volume and no ports. */
export async function candidateModelDevices(settings: HindsightSettings, imageId: string, kinds: string[]): Promise<Record<string, unknown> | undefined> {
    return withEnvironmentFile(settings, file => probe(["run", "--rm", "--pull", "never", "--gpus", "all", "--env-file", file, "--entrypoint", PYTHON, imageId], kinds));
}

/** Readiness: probe inside the running managed container, which already has its configuration and credentials. */
export async function serviceModelDevices(container: string, kinds: string[]): Promise<Record<string, unknown> | undefined> {
    return probe(["exec", container, PYTHON], kinds);
}
