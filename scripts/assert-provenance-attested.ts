// Fail-closed post-publish gate: proceed to the secondary git tag / release note ONLY
// when the npm registry *confirms* build-provenance attestations exist for the exact
// package@version this job just published.
//
// Why this exists (and why a green "Publish to npm with provenance" step is not enough):
// `npm publish --provenance` mints the attestation via a GitHub OIDC exchange as a SIDE
// EFFECT of publishing — a failed OIDC exchange does not make `npm publish` itself exit
// non-zero. This happened for real in the sibling package `@trdlabs/engine`: the publish
// step logged success, the attestation silently never generated, and nobody noticed until
// after the release shipped. npm is immutable per version — the only fix was forward, a
// new version. The class of defect is a step that ASSERTS a guarantee (provenance was
// requested, the command exited 0) instead of VERIFYING it (the registry actually holds
// an attestation for this version). This script asks the registry, the same question
// `npm audit signatures` / npmjs.com's own provenance badge answer from: does
// `dist.attestations` exist for this exact version on the registry — not "did the
// previous step's log look fine".
//
// `npm view <pkg>@<version> dist --json` is used over `npm audit signatures` because the
// latter verifies whatever is on disk/in the lockfile (registry *signatures*, which
// essentially every package has); it isn't scoped to "this one just-published version"
// and doesn't surface `provenance.predicateType` (the SLSA build attestation --provenance
// actually adds). It is used over a raw HTTP call to the attestations endpoint because it
// reuses the same authenticated registry client (and any configured registry URL) that
// `npm publish` itself just used, rather than hardcoding `registry.npmjs.org`.
//
// Mirrors the fail-closed shape of scripts/assert-version-publishable.ts: any outcome that
// is not a *confirmed* "attestations present" — a confirmed absence, a parse failure, or
// any registry/network/auth error — is treated as NOT attested. A naive
// `npm view … dist.attestations.url || true` would misread "field is empty because the
// command errored" as "field is empty because there is no attestation", which is exactly
// the false-negative this script exists to avoid.
//
// Usage: tsx scripts/assert-provenance-attested.ts <pkg> <version>
// Exit:  0 = attestations confirmed present · 1 = confirmed absent OR indeterminate.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface NpmViewDistResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type AttestationOutcome = 'attested' | 'missing' | 'indeterminate';

interface NpmDistShape {
  readonly attestations?: {
    readonly url?: unknown;
    readonly provenance?: {
      readonly predicateType?: unknown;
    };
  };
}

/** Pure classifier over an `npm view <pkg>@<version> dist --json` invocation. */
export function classifyAttestations(r: NpmViewDistResult): AttestationOutcome {
  // Any non-zero exit (registry E404 propagation lag right after publish, DNS, auth,
  // rate-limit, 5xx, timeout) is NOT evidence of absence. This runs moments after the
  // same job published the version, so it must exist; an error here means the question
  // could not be answered, not that the answer is "no attestations".
  if (r.status !== 0) return 'indeterminate';

  const out = r.stdout.trim();
  if (out.length === 0) return 'indeterminate';

  let dist: NpmDistShape;
  try {
    dist = JSON.parse(out) as NpmDistShape;
  } catch {
    // Non-JSON stdout (npm warning banners mixed into the stream, truncated output, a
    // registry proxy returning HTML on error) — the claim can't be read either way.
    return 'indeterminate';
  }

  const url = dist.attestations?.url;
  const predicateType = dist.attestations?.provenance?.predicateType;
  const hasUrl = typeof url === 'string' && url.length > 0;
  const hasPredicate = typeof predicateType === 'string' && predicateType.length > 0;

  // Both fields must be present and non-empty: this is the real published-without-
  // attestations shape (see left-pad@1.3.0 for a live example — `dist` exists, `dist.
  // attestations` does not), and it is a clean, confirmed "no" — not indeterminate.
  return hasUrl && hasPredicate ? 'attested' : 'missing';
}

export function runNpmViewDist(spec: string): NpmViewDistResult {
  const r = spawnSync('npm', ['view', spec, 'dist', '--json'], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function main(argv: readonly string[]): number {
  const [pkg, version] = argv;
  if (!pkg || !version) {
    console.error('Usage: tsx scripts/assert-provenance-attested.ts <pkg> <version>');
    return 1;
  }
  const spec = `${pkg}@${version}`;
  const outcome = classifyAttestations(runNpmViewDist(spec));
  switch (outcome) {
    case 'attested':
      console.log(`OK   ${spec} carries confirmed provenance attestations on the npm registry.`);
      return 0;
    case 'missing':
      console.error(
        `::error::${spec} was published but the npm registry reports NO provenance ` +
          `attestations (dist.attestations absent or incomplete). The publish step exiting ` +
          `0 did not guarantee the OIDC attestation exchange actually succeeded — this is the ` +
          `exact failure mode observed in @trdlabs/engine. Refusing to create the git tag / ` +
          `release note for a version the registry cannot attest to. npm is immutable: this ` +
          `version cannot be fixed in place, only superseded by the next one.`,
      );
      return 1;
    case 'indeterminate':
      console.error(
        `::error::Could not confirm attestation status for ${spec} (registry/network/parse ` +
          `error). Failing closed instead of tagging/releasing on an unverified state.`,
      );
      return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
