// Stand-in for @minecraft/server-ui. Forms resolve with whatever a test queues in
// `uiFake.responses` (default: submitted with no values), and are recorded in `uiFake.shown`.

export const uiFake = { responses: [], shown: [] };

function makeForm(kind) {
    const form = {
        kind, calls: [],
        title(t) { form.calls.push(["title", t]); return form; },
        body(t) { form.calls.push(["body", t]); return form; },
        button(...a) { form.calls.push(["button", ...a]); return form; },
        slider(...a) { form.calls.push(["slider", ...a]); return form; },
        toggle(...a) { form.calls.push(["toggle", ...a]); return form; },
        dropdown(...a) { form.calls.push(["dropdown", ...a]); return form; },
        textField(...a) { form.calls.push(["textField", ...a]); return form; },
        submitButton(t) { form.calls.push(["submitButton", t]); return form; },
        async show(player) {
            uiFake.shown.push({ kind, player, calls: form.calls });
            return uiFake.responses.shift() ?? { canceled: false, formValues: [], selection: 0 };
        }
    };
    return form;
}

export class ModalFormData { constructor() { return makeForm("modal"); } }
export class ActionFormData { constructor() { return makeForm("action"); } }
export class MessageFormData { constructor() { return makeForm("message"); } }
