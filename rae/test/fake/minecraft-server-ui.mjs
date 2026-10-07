// Stand-in for @minecraft/server-ui. Forms resolve with whatever a test queues in
// `uiFake.responses` (default: submitted with no values), and are recorded in `uiFake.shown`.
// A queued response may be a FUNCTION: it is called with { kind, calls, player } when the form is shown and answers
// the response, so a test can press "the button called Locks" without counting buttons.

export const uiFake = { responses: [], shown: [] };

function makeForm(kind) {
    const form = {
        kind, calls: [],
        title(t) { form.calls.push(["title", t]); return form; },
        label(t) { form.calls.push(["label", t]); return form; },
        header(t) { form.calls.push(["header", t]); return form; },
        divider() { form.calls.push(["divider"]); return form; },
        body(t) { form.calls.push(["body", t]); return form; },
        button(...a) { form.calls.push(["button", ...a]); return form; },
        button1(t) { form.calls.push(["button1", t]); return form; },
        button2(t) { form.calls.push(["button2", t]); return form; },
        slider(...a) { form.calls.push(["slider", ...a]); return form; },
        toggle(...a) { form.calls.push(["toggle", ...a]); return form; },
        dropdown(...a) { form.calls.push(["dropdown", ...a]); return form; },
        textField(...a) { form.calls.push(["textField", ...a]); return form; },
        submitButton(t) { form.calls.push(["submitButton", t]); return form; },
        async show(player) {
            uiFake.shown.push({ kind, player, calls: form.calls });
            const next = uiFake.responses.shift();
            const answer = typeof next === "function" ? next({ kind, player, calls: form.calls }) : next;
            return answer ?? { canceled: false, formValues: [], selection: 0 };
        }
    };
    return form;
}

export class ModalFormData { constructor() { return makeForm("modal"); } }
export class ActionFormData { constructor() { return makeForm("action"); } }
export class MessageFormData { constructor() { return makeForm("message"); } }

// What a form answers with when the player did not use it (the values the engine reports).
export const FormCancelationReason = { UserBusy: "UserBusy", UserClosed: "UserClosed" };
