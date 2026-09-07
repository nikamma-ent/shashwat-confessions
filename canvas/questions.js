// Single source of truth for the three canvases — read by the question
// dropdown and the canvas loader in app.js.
//
// `enabled: false` disables the option in the dropdown and refuses to
// load that canvas even if linked directly via ?q=. Flip it to `true`
// once the prompt is decided.
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
    },
    tbd: {
        slug: 'tbd',
        title: 'TBD',
        enabled: false
    }
};
