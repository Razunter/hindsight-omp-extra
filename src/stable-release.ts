const REPOSITORY = "ghcr.io/vectorize-io/hindsight";
export const STABLE_IMAGE = REPOSITORY + ":latest";
export interface StableRelease { version: string; url: string; image: string }

export async function latestStableRelease(): Promise<StableRelease | undefined> {
    try {
        const response = await fetch("https://api.github.com/repos/vectorize-io/hindsight/releases/latest", {
            headers: { Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(10_000),
            redirect: "error",
        });
        if (!response.ok) return undefined;
        const release = await response.json();
        if (release?.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) return undefined;
        const version = release.tag_name.slice(1);
        return { version, url: `https://github.com/vectorize-io/hindsight/releases/tag/${release.tag_name}`, image: `${REPOSITORY}:${version}` };
    } catch {
        return undefined;
    }
}
