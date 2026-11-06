import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, FileJson } from "lucide-react";
import { api, authorizedFetch } from "../api/client";
import type { Rec } from "../api/adapter";
import type { Me } from "../api/session";
import { Button, Empty, Field, SettingRow, SettingsSection, Status } from "../ui/kit";
import { SetUpProvider, saveBlob, toBase64, useSetUp, withValue, type Attachment, type Finish, type KitInfo, type Problem, type SetUpContext } from "./context";
import { AreasStep, BrandStep, CompanyStep, RegionStep, StartStep, blankFile } from "./StepsCompany";
import { PeopleStep, WorkStep } from "./StepsWork";
import { ConnectionsStep, DataStep, ResultList, WhereStep, useSummaries, type Result } from "./StepsLive";
import "./setup.css";

/**
 * "Set up a company" (#96): one full-page guided set-up. It writes one company file, the same one the server
 * applies on start, and ends either by setting up this copy or by downloading the package that deploys it
 * elsewhere. The draft is kept on the server as it's written, so a reload or another computer loses nothing.
 */

const STEPS = [
  { key: "start", title: "Start", heading: "What are you setting up?", text: "A demonstration and a real company go through the same steps. This choice sets sensible defaults for them." },
  { key: "company", title: "Company", heading: "The company", text: "How it appears on trip sheets, statements, invoices and messages." },
  { key: "region", title: "Region", heading: "Where it works", text: "Its currency, clock, and how it writes dates and numbers, on every screen, document and message." },
  { key: "brand", title: "Brand", heading: "How it looks", text: "The name, colour and logo people see, from the sign-in page to the driver's phone." },
  { key: "areas", title: "Areas", heading: "What it uses", text: "The parts of the app this company needs. Everything else stays out of the way." },
  { key: "work", title: "How it works", heading: "How it works", text: "The company's own words and rules. Every default is shown, and only what you change is kept." },
  { key: "people", title: "People", heading: "Who works here", text: "The owner, the staff at the desks, and what each may do." },
  { key: "connections", title: "Connections", heading: "Outside services", text: "E-mail, WhatsApp, SMS, file storage and the rest. Choose a method for each, or leave it simulated for now." },
  { key: "data", title: "Data", heading: "What it starts with", text: "Made-up records to look around in, the company's own spreadsheets, or nothing yet." },
  { key: "where", title: "Where it runs", heading: "Where it runs", text: "Right here, or a package to deploy somewhere else." },
  { key: "review", title: "Review", heading: "Review", text: "Everything you've chosen. Go back to anything that isn't right." },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

/** Which step a part of the company file belongs to. */
const STEP_OF: Record<string, StepKey> = {
  purpose: "start", company: "company", regional: "region", brand: "brand", watermark: "brand", areas: "areas",
  operations: "work", maintenance: "work", workspace: "work", owner: "people", staff: "people", roles: "people", selfSignUp: "people",
  connections: "connections", data: "data", deploy: "where",
};
const stepOf = (path: string) => STEP_OF[path.split(".")[0]!] ?? "review";

/** Problems in words for the person, in place of the validator's. */
const PLAIN: Record<string, string> = {
  "company.legalName": "The company's legal name is needed.",
  "company.key": "A short name is needed: 3–30 lowercase letters, digits or hyphens, starting with a letter.",
  "owner.email": "The owner's e-mail is needed.",
  "company.email": "That doesn't look like an e-mail address.",
  "company.phone": "Use the international format: + and the country code first.",
  "company.website": "A full address, starting with https://.",
};
const plainProblem = (p: Problem): Problem => ({
  path: p.path,
  message: PLAIN[p.path] ?? (/^(Invalid input|Too small|Invalid string)/.test(p.message) ? "This needs a value." : p.message),
});

const hashStep = () => {
  const key = location.hash.replace(/^#set-up\/?/, "");
  return STEPS.some((s) => s.key === key) ? (key as StepKey) : undefined;
};

export function SetUp({ me, onLeave }: { me: Me; onLeave: () => void }) {
  const info = useQuery({ queryKey: ["setup-kit"], queryFn: () => api<KitInfo>("/setup-kit"), staleTime: Infinity });
  const draft = useQuery({ queryKey: ["setup-draft"], queryFn: () => api<{ draft: Rec | null; attachments: Attachment[] }>("/setup-kit/draft"), staleTime: Infinity });
  const status = useQuery({ queryKey: ["setup-status"], queryFn: () => api<{ hasCompany: boolean; applied: boolean; finished: boolean }>("/setup-kit/status"), staleTime: 0 });
  if (info.error || draft.error) return <div className="su-wait"><Empty title="Could not open the set-up">{((info.error ?? draft.error) as Error).message}</Empty><Button onClick={onLeave}>Back to the app</Button></div>;
  if (!info.data || !draft.data || !status.data) return <div className="su-wait"><span className="spinner" aria-hidden /> Opening the set-up…</div>;
  return <Wizard me={me} info={info.data} saved={draft.data} hasCompany={status.data.hasCompany} onLeave={onLeave} />;
}

function Wizard({ me, info, saved, hasCompany, onLeave }: { me: Me; info: KitInfo; saved: { draft: Rec | null; attachments: Attachment[] }; hasCompany: boolean; onLeave: () => void }) {
  const client = useQueryClient();
  const [file, setFile] = useState<Rec>(() => saved.draft?.file as Rec ?? (hasCompany ? { ...info.file, owner: { email: me.email, name: me.name } } : blankFile(me)));
  const [attachments, setAttachments] = useState<Attachment[]>(saved.draft ? saved.attachments : info.attachments);
  const [step, setStep] = useState<StepKey>(() => hashStep() ?? (saved.draft?.step as StepKey | undefined) ?? "start");
  const [visited, setVisited] = useState<Set<string>>(() => new Set((saved.draft?.visited as string[] | undefined) ?? []));
  const [finish, setFinish] = useState<Finish>((saved.draft?.finish as Finish | undefined) ?? "here");
  const [problems, setProblems] = useState<Problem[]>([]);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "failed">("saved");
  const heading = useRef<HTMLHeadingElement>(null);

  /* The address follows the step, so back, forward and reload work. */
  useEffect(() => {
    const onHash = () => { const s = hashStep(); if (s) setStep(s); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = useCallback((next: string) => {
    setVisited((v) => new Set(v).add(step));
    location.hash = `#set-up/${next}`;
    setStep(next as StepKey);
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }, [step]);
  useEffect(() => { if (hashStep() !== step) history.replaceState(null, "", `#set-up/${step}`); }, [step]);

  /* The draft saves itself shortly after each change, and the problems are checked with it. */
  const first = useRef(true);
  const latest = useRef({ file, step, visited, finish });
  latest.current = { file, step, visited, finish };
  const saveNow = useCallback(async () => {
    const cur = latest.current;
    setSaveState("saving");
    try {
      await api("/setup-kit/draft", { method: "PUT", body: { file: cur.file, step: cur.step, visited: [...cur.visited], finish: cur.finish } });
      setSaveState("saved");
    } catch { setSaveState("failed"); }
  }, []);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => void saveNow(), 600);
    return () => clearTimeout(t);
  }, [file, step, visited, finish, saveNow]);
  useEffect(() => {
    const t = setTimeout(() => {
      api<{ problems: Problem[] }>("/setup-kit/check", { method: "POST", body: { file, finish } }).then((r) => setProblems(r.problems.map(plainProblem))).catch(() => undefined);
    }, 500);
    return () => clearTimeout(t);
  }, [file, finish, attachments]);

  const putFile = useCallback(async (path: string, chosen: Blob) => {
    const data = await toBase64(chosen);
    setAttachments((list) => [...list.filter((a) => a.path !== path), { path, data }]);
    await api("/setup-kit/draft/file", { method: "PUT", body: { path, data } });
  }, []);
  const removeFile = useCallback((path: string) => {
    setAttachments((list) => list.filter((a) => a.path !== path));
    void api("/setup-kit/draft/file/remove", { method: "POST", body: { path } });
  }, []);

  /** Shown only for a step already left, so a new page doesn't open full of complaints. */
  const err = useCallback((path: string) => {
    const owner = stepOf(path);
    if (!visited.has(owner) && step !== "review") return undefined;
    return problems.filter((p) => p.path === path || p.path.startsWith(`${path}.`)).map((p) => p.message).join(" ") || undefined;
  }, [problems, visited, step]);

  const ctx: SetUpContext = useMemo(() => ({
    file, info, me, attachments, putFile, removeFile, err, problems, finish, setFinish, go,
    set: (path, value) => setFile((f) => withValue(f, path, value)),
    replace: setFile,
  }), [file, info, me, attachments, putFile, removeFile, err, problems, finish, go]);

  const index = STEPS.findIndex((s) => s.key === step);
  const meta = STEPS[index]!;
  const leave = async () => { await saveNow(); client.removeQueries({ queryKey: ["setup-draft"] }); onLeave(); };

  return (
    <SetUpProvider value={ctx}>
      <div className="su">
        <Rail step={step} visited={visited} problems={problems} onGo={go} onLeave={() => void leave()} />
        <main className="su-main">
          <header className="su-head">
            <h1 ref={heading} tabIndex={-1}>{meta.heading}</h1>
            <p>{meta.text}</p>
          </header>
          <div className="su-body" key={step}>
            {step === "start" && <StartStep hasCompany={hasCompany} />}
            {step === "company" && <CompanyStep />}
            {step === "region" && <RegionStep />}
            {step === "brand" && <BrandStep />}
            {step === "areas" && <AreasStep />}
            {step === "work" && <WorkStep />}
            {step === "people" && <PeopleStep />}
            {step === "connections" && <ConnectionsStep />}
            {step === "data" && <DataStep />}
            {step === "where" && <WhereStep />}
            {step === "review" && <ReviewStep hasCompany={hasCompany} saveNow={saveNow} onLeave={onLeave} />}
          </div>
          <footer className="su-foot">
            <div className="su-foot-in">
              {index > 0 ? <Button onClick={() => go(STEPS[index - 1]!.key)}><ChevronLeft size={16} /> {STEPS[index - 1]!.title}</Button> : <span />}
              <span className={`su-saved ${saveState}`} aria-live="polite">{saveState === "saving" ? "Saving…" : saveState === "failed" ? "Couldn't save. It will try again when you change something." : "Saved"}</span>
              {index < STEPS.length - 1 && <Button tone="primary" onClick={() => go(STEPS[index + 1]!.key)}>{STEPS[index + 1]!.title} <ChevronRight size={16} /></Button>}
            </div>
          </footer>
        </main>
      </div>
    </SetUpProvider>
  );
}

function Rail({ step, visited, problems, onGo, onLeave }: { step: StepKey; visited: Set<string>; problems: Problem[]; onGo: (s: string) => void; onLeave: () => void }) {
  const summaries = useSummaries();
  const count = (key: string) => problems.filter((p) => stepOf(p.path) === key).length;
  const index = STEPS.findIndex((s) => s.key === step);
  return (
    <aside className="su-rail">
      <div className="su-rail-head">
        <strong>Set up a company</strong>
        <button type="button" className="su-leave" onClick={onLeave}>Save and leave</button>
      </div>
      {/* On a phone the steps are a list to pick from, as the rest of the app does. */}
      <label className="su-rail-pick">
        <span>Step {index + 1} of {STEPS.length}</span>
        <select value={step} onChange={(e) => onGo(e.target.value)} aria-label="Step">
          {STEPS.map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}
        </select>
      </label>
      <ol className="su-steps">
        {STEPS.map((s, i) => {
          const wrong = (visited.has(s.key) || s.key === "review") && s.key !== "review" ? count(s.key) : 0;
          const done = visited.has(s.key) && !wrong;
          return (
            <li key={s.key}>
              <button type="button" className={step === s.key ? "on" : ""} aria-current={step === s.key ? "step" : undefined} onClick={() => onGo(s.key)}>
                <span className={`su-step-mark ${done ? "done" : ""} ${wrong ? "wrong" : ""}`} aria-hidden>
                  {wrong ? <AlertCircle size={16} /> : done ? <Check size={15} /> : i + 1}
                </span>
                <span className="su-step-text">
                  <span>{s.title}</span>
                  <small>{wrong ? `${wrong} to fix` : visited.has(s.key) || step === s.key ? summaries[s.key] : ""}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

/* ---------- Review and finishing ---------- */

function ReviewStep({ hasCompany, saveNow, onLeave }: { hasCompany: boolean; saveNow: () => Promise<void>; onLeave: () => void }) {
  const { file, problems, finish, go, info, me } = useSetUp();
  const summaries = useSummaries();
  const [results, setResults] = useState<Result[]>([]);
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "failed" | "downloaded">("idle");
  const [error, setError] = useState("");
  const [logins, setLogins] = useState<DemoLogin[]>([]);
  const [clearing, setClearing] = useState(false);
  const [confirm, setConfirm] = useState("");
  const client = useQueryClient();
  const currentName = String(info.file.company?.tradingName || info.file.company?.legalName || "");
  const target = info.targets.find((t) => t.key === file.deploy?.target);
  const blocked = problems.length > 0;
  const outcome = useRef<HTMLDivElement>(null);
  // What happened is below the answers, so it's brought into view as it starts and when it ends.
  useEffect(() => { if (phase !== "idle") outcome.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [phase]);
  const failed = results.filter((r) => r.outcome === "failed").length;

  const applyHere = async () => {
    setPhase("running"); setResults([]); setError("");
    await saveNow();
    try {
      const res = await authorizedFetch("/setup-kit/apply", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file, ...(clearing ? { clear: { confirm } } : {}) }),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let ended = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const msg = JSON.parse(line) as Result & { type: string; message?: string; applied?: boolean; logins?: DemoLogin[] };
          if (msg.type === "step") setResults((r) => [...r, msg]);
          if (msg.type === "done") {
            ended = true;
            setLogins((was) => (msg.logins?.length ? msg.logins : was));
            // Clearing is one decision for one run: applying again must never clear again.
            setClearing(false);
            setConfirm("");
            setPhase("done");
          }
          if (msg.type === "error") { ended = true; setError(msg.message ?? "It stopped partway."); setPhase("failed"); }
        }
      }
      if (!ended) { setError("The connection ended before it finished. Check what was done, then try again."); setPhase("failed"); }
      void client.invalidateQueries();
    } catch (e) {
      setError((e as Error).message);
      setPhase("failed");
    }
  };
  const download = async () => {
    setError("");
    await saveNow();
    try {
      const res = await authorizedFetch("/setup-kit/kit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file, attachments: [] }) });
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "company-kit.zip";
      saveBlob(await res.blob(), name);
      setPhase("downloaded");
    } catch (e) { setError((e as Error).message); }
  };
  const saveCompanyFile = () => saveBlob(new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: "application/json" }), `${String(file.company?.key || "company")}.json`);

  return (
    <div className="su-stack">
      <SettingsSection title="Your answers">
        {STEPS.filter((s) => s.key !== "review").map((s) => {
          const mine = problems.filter((p) => stepOf(p.path) === s.key);
          return (
            <SettingRow key={s.key} title={s.title} description={mine.length ? undefined : summaries[s.key] || "Nothing entered"}>
              <span className="su-review-row">
                {mine.length > 0 && <span className="su-review-problems">{mine.map((p, i) => <span key={i}>{p.message}</span>)}</span>}
                <Button size="sm" tone={mine.length ? "secondary" : "quiet"} onClick={() => go(s.key)}>{mine.length ? "Fix" : "Change"}</Button>
              </span>
            </SettingRow>
          );
        })}
      </SettingsSection>

      {finish === "here" ? (
        <SettingsSection title="Set up this copy" description={hasCompany ? `This copy is ${currentName || "already in use"}. Its settings change to what's above; its records stay.` : "This copy becomes this company."}>
          {hasCompany && info.canClear && (
            <SettingRow title="Clear what's here first" description="Removes every record on this copy, including trips and money, and everyone except you. It can't be undone.">
              <Button tone={clearing ? "danger" : "secondary"} onClick={() => { setClearing(!clearing); setConfirm(""); }}>{clearing ? "Keep what's here" : "Clear it first"}</Button>
            </SettingRow>
          )}
          {clearing && currentName && (
            <div className="su-pad">
              <Field label={`Type ${currentName} to confirm`}><input className="input" value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} /></Field>
            </div>
          )}
          <div className="su-pad su-finish">
            <Button tone="primary" size="lg" busy={phase === "running"} disabled={blocked || phase === "running" || (clearing && Boolean(currentName) && confirm.trim().toLowerCase() !== currentName.toLowerCase())} onClick={() => void applyHere()}>
              {phase === "running" ? "Setting up…" : phase === "done" ? "Apply again" : "Set up this copy"}
            </Button>
            {blocked && <span className="su-finish-note">Fix what's marked above first.</span>}
          </div>
        </SettingsSection>
      ) : (
        <SettingsSection title={`A package for ${target?.label ?? "its platform"}`} description="One zip with everything needed to deploy this company. It holds no passwords or keys: you add those when you deploy.">
          <div className="su-pad su-finish">
            <Button tone="primary" size="lg" disabled={blocked} onClick={() => void download()}><Download size={16} /> Download the package</Button>
            <Button onClick={saveCompanyFile}><FileJson size={15} /> Save the company file</Button>
            {blocked && <span className="su-finish-note">Fix what's marked above first.</span>}
          </div>
          {phase === "downloaded" && (
            <div className="su-pad su-next">
              <Status tone="ok">Downloaded</Status>
              <ol>
                {(target?.steps ?? ["Unzip it. README.md inside is written for this company.", "Copy its settings file to .env and fill in each line marked SECRET.", "Run the deploy script named in the guide."]).map((s) => <li key={s}>{s}</li>)}
              </ol>
            </div>
          )}
        </SettingsSection>
      )}

      <div ref={outcome} className="su-outcome" />
      {error && <p className="su-note bad" role="alert">{error}</p>}
      {results.length > 0 && <SettingsSection title={phase === "running" ? "Setting up…" : "What happened"}><ResultList results={results} /></SettingsSection>}
      {phase === "done" && (
        <section className="su-done">
          <h2>{failed ? `Set up, with ${failed} ${failed === 1 ? "step" : "steps"} to look at` : `${String(file.company?.tradingName || file.company?.legalName)} is set up`}</h2>
          <p>{failed ? "Everything else worked. Fix what failed above, then apply again: what already worked is left alone." : file.purpose === "demo" ? "It's ready to show." : "Next, add what a first trip needs. Masters shows what's still missing."}</p>
          {logins.length > 0 && <DemoLogins logins={logins} owner={me.email} />}
          <Button tone="primary" size="lg" onClick={() => { history.replaceState(null, "", location.pathname); onLeave(); location.reload(); }}><ExternalLink size={16} /> Open the app</Button>
        </section>
      )}
    </div>
  );
}

interface DemoLogin { role: string; login: string; password: string }

/** Shown once: the server keeps only their hashes. Each side of the demonstration needs its own browser window. */
function DemoLogins({ logins, owner }: { logins: DemoLogin[]; owner: string }) {
  const [copied, setCopied] = useState(false);
  const text = logins.map((l) => `${l.role}: ${l.login} / ${l.password}`).join("\n");
  return (
    <div className="su-logins">
      <h3>Sign-ins for showing it around</h3>
      <p>One for each side of the work. Save them now: they aren't shown again. You stay signed in as {owner}, the owner. Use a private window for each extra person, because a browser holds one sign-in at a time.</p>
      <div className="cust-table-wrap">
        <table className="cust-table">
          <thead><tr><th>Who</th><th>Sign in with</th><th>Password</th></tr></thead>
          <tbody>{logins.map((l) => <tr key={l.login}><td>{l.role}</td><td className="su-mono">{l.login}</td><td className="su-mono">{l.password}</td></tr>)}</tbody>
        </table>
      </div>
      <Button onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)); }}><Copy size={15} /> {copied ? "Copied" : "Copy them"}</Button>
    </div>
  );
}

export default SetUp;
