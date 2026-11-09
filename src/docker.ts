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
 */
const CUDA_DOCKERFILE = `ARG BASE
FROM \${BASE}
ARG PYTORCH_CUDA_FLAVOR=cu126
ARG PYTORCH_CUDA_INDEX=https://download.pytorch.org/whl/cu126
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

/** Locally cached image metadata; registry digests come from RepoDigests, never from the image ID. */
export async function inspectImage(reference: string): Promise<ImageInfo | undefined> {
    const result = await docker(["image", "inspect", "--format", "{{json .}}", reference]);
    if (result.exitCode !== 0) return undefined;
    const image = JSON.parse(result.stdout);
    if (!/^sha256:[a-f0-9]{64}$/.test(image.Id) || !Array.isArray(image.RepoDigests ?? []) || !Array.isArray(image.RepoTags ?? [])) throw new Error("Invalid image metadata");
    return { id: image.Id, tags: image.RepoTags ?? [], digests: (image.RepoDigests ?? []).map((entry: string) => entry.slice(entry.indexOf("@") + 1)), labels: image.Config?.Labels ?? {} };
}

/**
 * Remove an image only when it has no tags and no container, running or stopped, uses it. Never forced and
 * never prunes parents, so another tag or container wins a concurrent race. False means removal failed.
 */
export async function removeUnusedImage(id: string): Promise<boolean> {
    const image = await inspectImage(id);
    if (!image || image.tags.length > 0) return true;
    const users = await docker(["ps", "--all", "--quiet", "--filter", "ancestor=" + id]);
    if (users.exitCode !== 0) return false;
    if (users.stdout.trim()) return true;
    return (await docker(["image", "rm", "--no-prune", id])).exitCode === 0;
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

/** Create and start the managed container from an image ID; credentials travel only through a 0600 env file. */
export async function runManagedContainer(settings: HindsightSettings, imageId: string, installationId: string): Promise<boolean> {
    const environmentDirectory = fs.mkdtempSync(path.join(tmpdir(), "hindsight-docker-"));
    try {
        const environmentFile = path.join(environmentDirectory, "env");
        fs.writeFileSync(environmentFile, Object.entries(settings.env).map(([key, value]) => `${key}=${value}`).join("\n"), { flag: "wx", mode: 0o600 });
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
    } finally {
        fs.rmSync(environmentDirectory, { recursive: true, force: true });
    }
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
            "--label", `${DERIVATIVE_LABEL}=cuda`,
            "--label", `${BASE_LABEL}=${base}`,
            context,
        ], BUILD_TIMEOUT)).exitCode === 0;
    } finally {
        fs.rmSync(context, { recursive: true, force: true });
    }
}

/** True when a throwaway container of `imageId` gets a GPU and its PyTorch sees CUDA; driver visibility alone is not enough. */
export async function cudaUsable(imageId: string): Promise<boolean> {
    return (await docker(["run", "--rm", "--pull", "never", "--gpus", "all", "--entrypoint", PYTHON, imageId, "-c", "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 3)"], 5 * 60_000)).exitCode === 0;
}
