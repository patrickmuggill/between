export type XPrompt = {
  id: string;
  label: string;
  description: string;
  instruction: string;
  needsDraft: boolean;
};

export type XPromptGroup = {
  id: string;
  label: string;
  prompts: XPrompt[];
};

const preserveVoice =
  " Preserve my actual position, vocabulary, uncertainty, and voice. Use the reference post as context, not as my opinion. Do not copy its distinctive phrasing or invent facts, examples, personal experience, agreement, or disagreement. Avoid clickbait, ragebait, engagement bait, and a generic contrarian voice. Do not add hashtags or emoji unless they are already part of my draft.";

const completePost =
  " Return only one complete revised post, ready to copy. Do not include a heading, explanation, alternatives, or quotation marks around the post.";

export const X_PROMPT_GROUPS: XPromptGroup[] = [
  {
    id: "angle",
    label: "Find an angle",
    prompts: [
      {
        id: "takeaway",
        label: "Find my takeaway",
        description: "Turn your reaction into one clear point.",
        needsDraft: false,
        instruction:
          "Help me work out what I want to say about the reference post. If my notes already express a reaction, write a short post around that specific takeaway. If I have not given a reaction, ask one brief question about a specific claim in the reference that will help me name what I think. Do not answer the question for me or choose my position. If there is no usable reference or reaction, ask what stayed with me after reading the post. Return only the post or the single question." +
          preserveVoice,
      },
      {
        id: "assumption",
        label: "Test the premise",
        description: "Find the assumption worth thinking through.",
        needsDraft: false,
        instruction:
          "Identify one consequential assumption in the reference post, staying fair to what it actually says. If my draft already questions an assumption, turn my reasoning into a clear post without making the disagreement stronger. Otherwise, ask me one specific, open question that helps me decide when that assumption holds or breaks down. Do not presume the author is wrong or invent a contrarian opinion for me. If there is no usable reference, ask which claim I want to examine. Return only the post or the single question." +
          preserveVoice,
      },
      {
        id: "disagreement",
        label: "Disagree well",
        description: "State the difference without picking a fight.",
        needsDraft: true,
        instruction:
          "Rewrite my draft so the precise point I disagree with and my reason are easy to understand. Address the claim, not the author's motives or character. Keep any genuine agreement or uncertainty that matters. Do not create disagreement if my draft does not express it; in that case, clarify my existing point." +
          preserveVoice + completePost,
      },
    ],
  },
  {
    id: "sharpen",
    label: "Sharpen the draft",
    prompts: [
      {
        id: "opening",
        label: "Lead with the point",
        description: "Give the first line something real to say.",
        needsDraft: true,
        instruction:
          "Improve the opening of my draft by leading with its most specific, interesting point. Remove throat-clearing and vague teasers. Let the substance earn attention without exaggerating it. Keep the rest of the draft unless it needs a small change to flow from the new opening. Avoid formulas such as 'Nobody talks about' or 'The uncomfortable truth.'" +
          preserveVoice + completePost,
      },
      {
        id: "specific",
        label: "Make it concrete",
        description: "Trade vague claims for details you already gave.",
        needsDraft: true,
        instruction:
          "Make my draft more concrete using only the details, mechanisms, or examples already present in my writing or the reference. Make clear when a detail comes from the reference. Replace vague abstractions with plain descriptions and direct verbs. Do not fabricate a number, anecdote, example, or result to make the post sound convincing. If no supporting detail is available, narrow the claim rather than inventing evidence." +
          preserveVoice + completePost,
      },
      {
        id: "trim",
        label: "Cut the filler",
        description: "Keep the substance. Lose the extra words.",
        needsDraft: true,
        instruction:
          "Tighten my draft with the smallest effective edit. Cut repetition, generic setup, empty qualifiers, and a closing line that only repeats the point. Keep distinctive phrasing, useful details, humor, and words that express real uncertainty. Keep the rhythm natural instead of turning every sentence into a punchy fragment." +
          preserveVoice + completePost,
      },
    ],
  },
  {
    id: "voice",
    label: "Make it yours",
    prompts: [
      {
        id: "nuance",
        label: "Keep the nuance",
        description: "Make the claim as precise as your thinking.",
        needsDraft: true,
        instruction:
          "Refine my draft so its claim does not go further than my reasoning supports. Preserve relevant limits, tradeoffs, and uncertainty already expressed in my writing or clearly established by the reference. Keep my position clear; do not add a generic both-sides caveat or soften an opinion merely because it is strong. Do not invent a new belief or unsupported exception." +
          preserveVoice + completePost,
      },
      {
        id: "fit",
        label: "Fit one post",
        description: "Aim for 280 characters, without losing the point.",
        needsDraft: true,
        instruction:
          "Condense my draft into one X post within the provided post_budget of weighted characters, leaving a little room for counting differences. Preserve the central point and the qualification that matters most. Use full words and natural sentences. Do not turn it into a thread, use unexplained abbreviations, or add a link to the reference unless my draft already includes it. Do not claim you have verified X's character count." +
          preserveVoice + completePost,
      },
      {
        id: "question",
        label: "Ask a useful question",
        description: "Invite a specific answer you would want to read.",
        needsDraft: true,
        instruction:
          "Revise my draft to end with one specific, open question that follows from the point I have actually made. Ask about a concrete experience, condition, or unresolved tradeoff that a reader could usefully answer. Keep the question honest; do not hide a claim in a loaded question or ask merely for engagement. Avoid 'Thoughts?', 'Agree?', and 'Am I the only one?' Keep the rest of my draft unless a small edit improves the connection." +
          preserveVoice + completePost,
      },
    ],
  },
];
