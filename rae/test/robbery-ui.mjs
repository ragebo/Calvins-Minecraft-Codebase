// A stand-in for the player at a form: presses a button by its label, fills a modal form by its labels, answers yes or
// no. Shared by the tests that drive core/robberyforms.ts. A button or control it cannot find is recorded in `problems`
// (and the form is closed) instead of throwing, so a test asserts there were none.
import { fakeUi, strip } from "./helpers.mjs";

export const ui = fakeUi.uiFake;
export const problems = [];

export const buttonsOf = (form) => form.calls.filter((c) => c[0] === "button").map((c) => String(c[1]));
export const titleOf = (form) => String(form.calls.find((c) => c[0] === "title")?.[1] ?? "");

/** Presses the first button whose label contains `text`. */
export const press = (text) => (form) => {
    const buttons = buttonsOf(form);
    const index = buttons.findIndex((b) => strip(b).includes(text));
    if (index < 0) {
        problems.push(`no button "${text}" on "${strip(titleOf(form))}": ${buttons.map(strip).join(" | ")}`);
        return { canceled: true, cancelationReason: "UserClosed" };
    }
    return { canceled: false, selection: index };
};

export const close = () => ({ canceled: true, cancelationReason: "UserClosed" });

/** Fills a form in: `answers` maps a fragment of a control's label to its value; anything not mentioned keeps its default. */
export const fill = (answers = {}) => (form) => {
    const controls = form.calls.filter((c) => ["textField", "toggle", "dropdown", "slider"].includes(c[0]));
    const used = new Set();

    const values = controls.map((control) => {
        const [kind, label] = control;
        const key = Object.keys(answers).find((k) => strip(String(label)).includes(k));
        if (key !== undefined) used.add(key);

        if (kind === "textField") return key !== undefined ? String(answers[key]) : control[3]?.defaultValue ?? "";
        if (kind === "toggle") return key !== undefined ? answers[key] : control[2]?.defaultValue ?? false;
        if (kind === "slider") return key !== undefined ? answers[key] : control[4]?.defaultValue ?? control[2];

        const items = control[2];
        if (key === undefined) return control[3]?.defaultValueIndex ?? 0;
        const wanted = answers[key];
        const exact = items.findIndex((item) => strip(String(item)) === wanted);
        const index = typeof wanted === "number" ? wanted : exact >= 0 ? exact : items.findIndex((item) => strip(String(item)).includes(wanted));
        if (index < 0) problems.push(`no choice "${wanted}" in "${strip(String(label))}": ${items.join(" | ")}`);
        return Math.max(0, index);
    });

    for (const key of Object.keys(answers)) if (!used.has(key)) problems.push(`no control matching "${key}" on "${strip(titleOf(form))}"`);

    return { canceled: false, formValues: values };
};

/** Answers a yes/no question: pressing "yes" is the second button. */
export const yes = () => ({ canceled: false, selection: 1 });
export const no = () => ({ canceled: false, selection: 0 });

/**
 * Queues what the stand-in does, replacing whatever an earlier script left unused, and follows it with enough closes that any
 * screen left open unwinds instead of looping.
 */
export function script(...steps) {
    ui.responses.length = 0;
    ui.responses.push(...steps, ...Array.from({ length: 40 }, () => close));
}

