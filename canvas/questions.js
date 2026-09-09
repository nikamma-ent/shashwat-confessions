// Single source of truth for the canvases — read by the question dropdown
// and the canvas loader in app.js.
//
// `enabled: false` disables the option in the dropdown and refuses to
// load that canvas even if linked directly via ?q=. To add a new
// question, add an entry here (and add its slug to firestore.rules'
// canvasId allowlist) — everything else picks it up automatically.
export const QUESTIONS = {
    human: {
        slug: 'human',
        title: 'What does it take to be human?',
        enabled: true
    },
    lie: {
        slug: 'lie',
        title: 'Why do we lie?',
        enabled: true
    }
};
