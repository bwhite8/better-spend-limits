"use client";

/**
 * Replacing the employee roster from an HRIS export (plan §Phase 13).
 *
 * This is the most destructive control in the app: `employees` is where §G8 gets
 * every answer about who may see and change whose spend limit, and an import
 * replaces all of it. So the flow is deliberately two-step — choose a file, read
 * what it contains, then confirm — and the file is validated in the browser
 * before the button becomes pressable. The server re-validates regardless; the
 * client copy is there to make a bad file obvious in a second rather than a
 * round trip.
 *
 * On success the page is NOT refreshed in place. An admin can legitimately
 * upload a roster they are not on, and refreshing would replace their
 * confirmation with a 403 that looks like a failure. The reload is theirs to
 * make, as a full navigation, because their identity may have just changed.
 */

import { useRef, useState, useTransition } from "react";

import { EMPLOYEE_CSV_HEADER, parseEmployeeCsv, type ParsedEmployeeCsv } from "@/lib/import-employees";

import { importEmployees } from "./actions";
import type { AdminActionResult } from "./types";

/** Enough to see the shape of the problem without scrolling for a minute. */
const MAX_SHOWN_ISSUES = 10;

export function EmployeeImport() {
  const [pending, startTransition] = useTransition();
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ParsedEmployeeCsv | null>(null);
  const [result, setResult] = useState<AdminActionResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const choose = async (file: File | undefined) => {
    setResult(null);

    if (file === undefined) {
      setCsv(null);
      setFileName(null);
      setPreview(null);
      return;
    }

    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    setPreview(parseEmployeeCsv(text));
  };

  const importable = csv !== null && preview !== null && preview.errors.length === 0 && preview.rows.length > 0;

  const confirm = () => {
    if (!importable || csv === null) return;
    setResult(null);

    startTransition(async () => {
      const answer = await importEmployees(csv);
      setResult(answer);

      if (answer.ok) {
        // The uploaded roster is now the truth; the chosen file is spent.
        setCsv(null);
        setPreview(null);
        setFileName(null);
        if (inputRef.current !== null) inputRef.current.value = "";
      }
    });
  };

  const issues = (result?.issues ?? preview?.errors ?? []).slice(0, MAX_SHOWN_ISSUES);
  const totalIssues = result?.issues?.length ?? preview?.errors.length ?? 0;

  return (
    <div data-testid="import-form" className="flex max-w-2xl flex-col gap-4">
      <p className="text-xs text-slate-500">
        A CSV whose header is exactly{" "}
        {/*
          One unbroken 868px token. Without a break opportunity it forces the
          whole page wider than a phone viewport, so `wrap-anywhere` — which,
          unlike `break-words`, also lowers the element's min-content width — is
          what keeps `/admin` free of horizontal page scroll.
        */}
        <code className="rounded bg-slate-100 px-1 py-0.5 wrap-anywhere dark:bg-slate-800">
          {EMPLOYEE_CSV_HEADER.join(",")}
        </code>
        . Manager and AI-lead columns name another <code>employee_id</code> in the same file, and
        blank means &ldquo;no one&rdquo;. Importing REPLACES every employee record; matched Claude
        user ids are kept for addresses that appear in both rosters.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        disabled={pending}
        data-testid="import-file"
        onChange={(event) => void choose(event.target.files?.[0])}
        className="text-sm file:mr-3 file:rounded file:border-0 file:bg-slate-900 file:px-3 file:py-2.5 file:text-sm file:font-medium file:text-white md:file:py-1.5 dark:file:bg-slate-100 dark:file:text-slate-900"
      />

      {preview === null ? null : (
        <p data-testid="import-preview" className="text-sm">
          <span className="font-medium">{fileName}</span> — {preview.rows.length} readable{" "}
          {preview.rows.length === 1 ? "row" : "rows"},{" "}
          {preview.errors.length === 0 ? "no problems" : `${preview.errors.length} problems`}.
        </p>
      )}

      {issues.length === 0 ? null : (
        <ul className="flex flex-col gap-1 rounded border border-red-200 p-3 text-xs text-red-700 dark:border-red-900 dark:text-red-300">
          {issues.map((issue, index) => (
            <li key={`${issue.line}-${index}`} data-testid="import-issue">
              Line {issue.line}: {issue.message}
            </li>
          ))}
          {totalIssues > issues.length ? (
            <li className="text-slate-500">…and {totalIssues - issues.length} more.</li>
          ) : null}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={confirm}
          disabled={pending || !importable}
          data-testid="import-confirm"
          className="inline-flex min-h-11 items-center justify-center rounded bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60 md:min-h-0 md:py-1.5"
        >
          {pending ? "Importing…" : "Replace roster"}
        </button>

        {result === null ? null : (
          <p
            role={result.ok ? "status" : "alert"}
            data-testid={result.ok ? "import-done" : "import-error"}
            className={`text-sm ${result.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600"}`}
          >
            {result.message}
          </p>
        )}
      </div>

      {result?.ok === true ? (
        // A full navigation, not `router.refresh()`: the roster this page was
        // rendered from no longer exists, and so possibly does the viewer.
        <a
          href="/admin"
          data-testid="import-reload"
          className="text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300"
        >
          Reload the admin page
        </a>
      ) : null}
    </div>
  );
}
