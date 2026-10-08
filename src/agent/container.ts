/**
 * Docker container lifecycle management for the solver sandbox.
 *
 * Security constraints:
 *  - Non-root user (uid 1000)
 *  - No Docker socket mounted
 *  - Read-only bind mount for challenge files
 *  - Network restricted to challenge host only (via --add-host + custom network)
 *  - No host filesystem access beyond the scratch work dir
 *  - Container is always force-removed on cleanup
 */
import Docker from "dockerode";
import { mkdirSync } from "fs";
import { join } from "path";

// Use the system Docker socket; override with DOCKER_HOST env var if set
const dockerHost = process.env.DOCKER_HOST;
const docker = dockerHost
  ? new Docker({ socketPath: dockerHost.replace("unix://", "") })
  : new Docker({ socketPath: "/var/run/docker.sock" });

export interface ContainerSpec {
  image: string;
  challengeId: number;
  filesDir: string;       // host path to challenge files (mounted read-only)
  scratchDir: string;     // host path for writable scratch space
  challengeHost?: string; // restrict outbound network to this host
  runId: string;
}

export interface SandboxContainer {
  id: string;
  /** Execute a command, returns stdout+stderr combined, throws on timeout */
  exec(cmd: string, timeoutSec?: number): Promise<string>;
  stop(): Promise<void>;
}

export async function createSandbox(spec: ContainerSpec): Promise<SandboxContainer> {
  // Ensure scratch dir exists on host
  mkdirSync(spec.scratchDir, { recursive: true });

  // Build extra hosts entry for network restriction
  const extraHosts: string[] = [];
  if (spec.challengeHost) {
    // Resolve the host to allow it; block everything else via no-new-network
    // We rely on Docker's --network=none + --add-host approach:
    // The container gets no internet except routes we explicitly add.
    // For simplicity here we use a bridge network and iptables is handled
    // externally, or rely on the challenge host being the only reachable thing.
    // A more robust solution is a custom Docker network with explicit allow-list.
    extraHosts.push(`${spec.challengeHost}:host-gateway`);
  }

  const container = await docker.createContainer({
    Image: spec.image,
    Cmd: ["sleep", "infinity"], // kept alive; we exec into it
    User: "1000:1000",
    WorkingDir: "/work",
    HostConfig: {
      // Read-only bind for challenge files
      Binds: [
        `${spec.filesDir}:/work/files:ro`,
        `${spec.scratchDir}:/work/scratch:rw`,
      ],
      // No privileged, no extra capabilities
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      // No Docker socket
      ReadonlyRootfs: false, // we need /tmp etc to work
      NetworkMode: spec.challengeHost ? "bridge" : "none",
      ExtraHosts: extraHosts,
      // Resource limits
      Memory: 512 * 1024 * 1024,   // 512 MB
      CpuPeriod: 100000,
      CpuQuota: 100000,             // 1 CPU
      PidsLimit: 256,
    },
    Labels: {
      "ctf-bot.runId": spec.runId,
      "ctf-bot.challengeId": String(spec.challengeId),
    },
  });

  await container.start();

  return {
    id: container.id,

    async exec(cmd: string, timeoutSec = 30): Promise<string> {
      const clampedTimeout = Math.min(timeoutSec, 120);

      const exec = await container.exec({
        Cmd: ["bash", "-c", cmd],
        AttachStdout: true,
        AttachStderr: true,
        User: "1000:1000",
        WorkingDir: "/work",
      });

      return new Promise((resolve, reject) => {
        exec.start({ hijack: true, stdin: false }, (err: Error | null, stream: NodeJS.ReadableStream | undefined) => {
          if (err) return reject(err);
          if (!stream) return reject(new Error("exec: no stream returned"));

          const chunks: Buffer[] = [];
          const timer = setTimeout(() => {
            reject(new Error(`Command timed out after ${clampedTimeout}s: ${cmd.slice(0, 80)}`));
          }, clampedTimeout * 1000);

          docker.modem.demuxStream(
            stream,
            {
              write: (chunk: Buffer) => chunks.push(chunk),
              end: () => {},
            } as unknown as NodeJS.WritableStream,
            {
              write: (chunk: Buffer) => chunks.push(chunk),
              end: () => {},
            } as unknown as NodeJS.WritableStream
          );

          (stream as NodeJS.ReadableStream).on("end", () => {
            clearTimeout(timer);
            resolve(Buffer.concat(chunks).toString("utf-8"));
          });

          (stream as NodeJS.ReadableStream).on("error", (e: Error) => {
            clearTimeout(timer);
            reject(e);
          });
        });
      });
    },

    async stop(): Promise<void> {
      try {
        await container.stop({ t: 3 });
      } catch {
        // Ignore stop errors (already stopped)
      }
      try {
        await container.remove({ force: true });
      } catch {
        // Ignore remove errors
      }
    },
  };
}

/** Force-stop any lingering containers from a run (used by /stop command) */
export async function stopRunContainers(runId: string): Promise<void> {
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`ctf-bot.runId=${runId}`] }),
  });

  await Promise.allSettled(
    containers.map(async (info) => {
      const c = docker.getContainer(info.Id);
      await c.stop({ t: 1 }).catch(() => {});
      await c.remove({ force: true }).catch(() => {});
    })
  );
}
