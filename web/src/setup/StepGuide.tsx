import { useEffect, useState } from "react";
import { Check, Copy, Download, ExternalLink } from "lucide-react";
import { api } from "../api/client";
import { Button, Status } from "../ui/kit";
import { saveBlob, useSetUp } from "./context";

/**
 * What to do with the package: every environment variable, what it's for and where to get it, and each step with
 * this company's own values in the commands. The app never holds a secret; it says what to do with each one.
 */

interface EnvVar { name: string; value?: string; secret: boolean; why: string; where?: string; generate?: string; automatic?: boolean; command?: string }
interface GuideStep { title: string; text?: string; commands?: string[]; link?: { href: string; label: string } }
interface Guide { problems: { path: string; message: string }[]; env?: EnvVar[]; steps?: GuideStep[]; envFile?: string; hasSource?: boolean }

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="su-copy" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />} {done ? "Copied" : label}
    </button>
  );
}

function Commands({ lines }: { lines: string[] }) {
  return (
    <div className="su-code">
      <pre>{lines.join("\n")}</pre>
      <CopyButton text={lines.join("\n")} />
    </div>
  );
}

export function DeployGuide() {
  const { file, go } = useSetUp();
  const [guide, setGuide] = useState<Guide | null>(null);
  useEffect(() => {
    const t = setTimeout(() => { api<Guide>("/setup-kit/guide", { method: "POST", body: { file } }).then(setGuide).catch(() => undefined); }, 250);
    return () => clearTimeout(t);
  }, [file]);
  if (!guide) return <p className="muted">Working it out for this company…</p>;
  if (guide.problems.length || !guide.env) {
    return (
      <div className="su-note bad">
        This guide is written from your answers, so these need fixing first:
        <ul>{guide.problems.slice(0, 6).map((p, i) => <li key={i}><code>{p.path}</code> {p.message}</li>)}</ul>
        <Button size="sm" onClick={() => go("review")}>See them all</Button>
      </div>
    );
  }
  const secrets = guide.env.filter((v) => v.secret);
  const plain = guide.env.filter((v) => !v.secret && v.value);
  const toFill = secrets.filter((v) => !v.automatic);
  return (
    <div className="su-stack">
      <section className="su-guide-part">
        <h2>Secrets you'll need</h2>
        <p>{toFill.length} to have ready. They're never kept in this app or in the package. You put them in a settings file when you deploy, and the script hands them to {file.deploy?.target === "gcp" ? "Google Secret Manager" : file.deploy?.target === "compose" ? "the server's own settings file" : "the platform's secret store"}.</p>
        <div className="cust-table-wrap su-env">
          <table className="cust-table">
            <thead><tr><th>Environment variable</th><th>What it's for</th><th>Where to get it</th></tr></thead>
            <tbody>
              {secrets.map((v) => (
                <tr key={v.name}>
                  <td className="su-env-name"><code>{v.name}</code>{v.automatic && <Status tone="ok">Made for you</Status>}</td>
                  <td className="su-wrap">{v.why}</td>
                  <td className="su-wrap">
                    {v.where}
                    {v.generate && <><span>Make one with:</span><Commands lines={[v.generate]} /></>}
                    {v.command && (
                      <details className="su-env-more">
                        <summary>Or set it directly</summary>
                        <Commands lines={[v.command]} />
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="su-env-more">
          <summary>{plain.length} other settings, already filled in from your answers</summary>
          <div className="cust-table-wrap su-env">
            <table className="cust-table"><tbody>{plain.map((v) => <tr key={v.name}><td><code>{v.name}</code></td><td className="su-mono">{v.value}</td></tr>)}</tbody></table>
          </div>
        </details>
        <div className="su-actions">
          <Button onClick={() => saveBlob(new Blob([guide.envFile ?? ""], { type: "text/plain" }), ".env.example")}><Download size={14} /> Download the settings file</Button>
          <CopyButton text={guide.envFile ?? ""} label="Copy all of it" />
        </div>
      </section>

      <section className="su-guide-part">
        <h2>Step by step</h2>
        <ol className="su-guide-steps">
          {(guide.steps ?? []).map((s, i) => (
            <li key={s.title}>
              <span className="su-guide-number" aria-hidden>{i + 1}</span>
              <div>
                <h3>{s.title}</h3>
                {s.text && <p>{s.text}</p>}
                {s.link && <a className="su-link" href={s.link.href} target="_blank" rel="noreferrer">{s.link.label} <ExternalLink size={13} aria-hidden /></a>}
                {s.commands && <Commands lines={s.commands} />}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
