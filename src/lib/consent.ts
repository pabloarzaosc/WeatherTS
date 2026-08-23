/**
 * The data notice a person agrees to before an account exists.
 *
 * This file is the only copy of that wording. It is written as data rather
 * than as markup so the same text can be shown on the sign-up step, shown
 * again to an account that predates it, and stored by version against the
 * profile that accepted it.
 *
 * Every claim below was checked against the code that makes it true:
 *   - the profile columns are the columns in `profiles`
 *   - the broadcast fields are the fields in `publish()` in chasers.ts
 *   - the third-party hosts are every https:// origin the client contacts
 *   - "no analytics" is nine runtime dependencies, none of which report
 *
 * If any of that changes, this file changes with it, and TERMS_VERSION goes
 * up so everyone is asked again. A notice that drifts from the code is worse
 * than none, because it is believed.
 */

/** Bump on any change of substance. Stored against the profile that agreed. */
export const TERMS_VERSION = "2026-08-23";

/** Where someone can ask about any of this. */
export const CONTACT_EMAIL = "hello@weatherts.app";

export interface ConsentPoint {
  /** The thing itself: a field, a permission, a recipient. */
  term: string;
  /** What happens to it, in plain words. */
  detail: string;
  /** Who ends up able to see it. */
  visibility?: "private" | "public" | "shared";
  /** Whether the person can decline this one and still have an account. */
  optional?: boolean;
}

export interface ConsentSection {
  /** Stable handle for the icon and styling the panel puts on this section.
   *  Separate from the title so rewording the heading never silently changes
   *  how it looks. */
  id: string;
  title: string;
  /** Drawn as a callout rather than a plain block. Reserved for the section
   *  someone would most regret skimming. */
  emphasis?: boolean;
  intro?: string;
  points?: ConsentPoint[];
  /** Plain paragraphs, for sections that are not a list of fields. */
  paragraphs?: string[];
}

export const CONSENT_SECTIONS: ConsentSection[] = [
  {
    id: "why",
    title: "What an account is for",
    paragraphs: [
      "WeatherTS needs an account for one reason: so that chasers on the map have a name and a face " +
        "that belong to them, and cannot be worn by somebody else. Everything else the app does — radar, " +
        "warnings, soundings, models — works the same whether you are signed in or not.",
      "There is no paid tier, nothing is sold, and none of what follows is used for advertising.",
    ],
  },
  {
    id: "signup",
    title: "What you give us when you sign up",
    intro: "This is the whole list. Nothing else is asked for and nothing else is kept.",
    points: [
      {
        term: "Email address",
        detail:
          "Required. It identifies the account, receives the verification link, and receives a reset link " +
          "if you forget your password. It is never shown to other users and never sent to anyone else.",
        visibility: "private",
      },
      {
        term: "Password",
        detail:
          "Required for email sign-up. It is stored only as a cryptographic hash by Supabase Auth. The app " +
          "never keeps it, nobody running WeatherTS can read it, and it cannot be recovered — only reset.",
        visibility: "private",
      },
      {
        term: "Username",
        detail:
          "Required, and public. It is the handle beside your position on the map and the key other clients " +
          "use to find your name and picture. Lowercase letters, numbers, dots, dashes and underscores.",
        visibility: "public",
      },
      {
        term: "Display name",
        detail: "Optional, and public if you set one. Shown instead of the handle where there is room for it.",
        visibility: "public",
        optional: true,
      },
      {
        term: "Profile photo",
        detail:
          "Optional, and public if you upload one. The file is stored in a public bucket, which means anyone " +
          "holding the link can open it — including someone who is not signed in. Deleting it removes the file.",
        visibility: "public",
        optional: true,
      },
      {
        term: "Account dates and role",
        detail:
          "When the account was created and last changed, and whether it carries a chaser, tester or developer " +
          "title. The title is public; the dates are not.",
        visibility: "private",
      },
    ],
  },
  {
    id: "google",
    title: "If you sign in with Google instead",
    intro: "Google hands over exactly four things, and WeatherTS asks for nothing beyond them:",
    points: [
      { term: "Your name", detail: "Used to fill in the display name. You can change or clear it afterwards.", visibility: "public" },
      { term: "Your email address", detail: "Used the same way as above — to identify the account.", visibility: "private" },
      { term: "Your Google profile picture", detail: "Used as the profile photo until you replace it.", visibility: "public" },
      { term: "A Google account identifier", detail: "So the same Google account signs in to the same WeatherTS account next time.", visibility: "private" },
    ],
  },
  {
    id: "location",
    emphasis: true,
    title: "Where you are — the part worth reading twice",
    intro:
      "Location is the only data here that could tell someone where to find you. Both uses below are off " +
      "until you switch them on, and either can be switched off at any time.",
    points: [
      {
        term: "Home pin",
        detail:
          "Optional. If you set one, the coordinates are rounded to about a kilometre BEFORE they are stored — " +
          "there is no precise copy sitting in the database to leak later. It stays private unless you turn on " +
          "\"make my home public\", and only then do the rounded coordinates and the label you typed leave your " +
          "own row.",
        visibility: "private",
        optional: true,
      },
      {
        term: "Live position sharing",
        detail:
          "Optional, and off by default. While it is on, the app broadcasts your latitude and longitude to about " +
          "a metre, along with your heading, speed, position accuracy and your username, to every other signed-in " +
          "user running WeatherTS. It is not written to any database: it exists only while you are connected and " +
          "disappears the moment you disconnect or switch it off. Nothing is recorded, so there is no history of " +
          "where you have been.",
        visibility: "shared",
        optional: true,
      },
      {
        term: "How your position is read",
        detail:
          "First from your device's own location service. If that fails — which it does on some Windows machines, " +
          "because the desktop build has no Google location key — the app asks one of three third-party lookup " +
          "services (ipwho.is, GeoJS or ipbase) what city an IP address is in. Those services see your IP address. " +
          "This never happens if you refuse the location permission: a refusal is treated as an answer, not as a " +
          "problem to route around.",
        visibility: "shared",
        optional: true,
      },
    ],
  },
  {
    id: "network",
    title: "What every network request reveals",
    intro:
      "WeatherTS is a desktop app that reads public weather data, so it contacts the services that publish it. " +
      "Each one necessarily sees your IP address, the same as any website you visit. In full, they are:",
    points: [
      { term: "Supabase", detail: "Your account, profile and the live positions channel. This is where the account data above lives." },
      { term: "GitHub", detail: "Update checks and the installer download." },
      { term: "NOAA and the National Weather Service", detail: "Warnings, outlooks, observations, radar and model data. api.weather.gov and mapservices.weather.noaa.gov." },
      { term: "Map tiles and imagery", detail: "OpenFreeMap, Esri/ArcGIS, NASA GIBS and OpenTopoMap, depending on which basemap you pick." },
      { term: "Photon (Komoot)", detail: "The place search. What you type into the search box is sent there to be matched — so treat it as public." },
      { term: "The sounding analysis service", detail: "Sounding and profile computation for points you open. It receives the coordinates you asked about." },
      { term: "IP location services", detail: "Only in the fallback case described above." },
    ],
  },
  {
    id: "never",
    title: "What is NOT collected",
    paragraphs: [
      "There is no analytics, no crash reporting, no advertising and no third-party tracker of any kind. The app " +
        "ships with nine libraries and not one of them reports back.",
      "Your address is never asked for. Neither is your phone number, your date of birth, your real name, a " +
        "payment method, your contacts, your files, or anything from your device beyond the location you " +
        "explicitly turn on.",
      "Nothing you do inside the app — which radars you open, which storms you follow, where you pan the map — " +
        "is sent anywhere or recorded. Your settings stay on your own machine.",
    ],
  },
  {
    id: "retention",
    title: "Keeping it, and getting rid of it",
    paragraphs: [
      "Account data is kept for as long as the account exists. Live positions are kept for no time at all: they " +
        "are never stored in the first place.",
      "Deleting your account, from Account → Delete account, removes the profile row and the profile photo, and " +
        "your position vanishes from every other map immediately. It cannot be undone.",
      "You can change or clear any optional field at any time without deleting the account: the display name, the " +
        "photo, the home pin, and position sharing.",
    ],
  },
  {
    id: "who",
    title: "Who is behind this",
    paragraphs: [
      "WeatherTS is made by one person, Pablo Arzão, and is not a company. Account data is held in Supabase, which " +
        "processes it on WeatherTS's behalf.",
      `Questions about any of the above, or a request to see or delete what is held about you, go to ${CONTACT_EMAIL}.`,
      "If this notice changes in a way that matters, you will be asked to read and accept it again before " +
        "continuing — not told about it in a changelog you would never see.",
    ],
  },
];

/**
 * The gist, before the detail.
 *
 * Nobody reads a notice from the top when they do not yet know whether it is
 * going to matter to them. These three lines say which parts do, so the long
 * version is read by someone who knows what they are looking for.
 */
export const CONSENT_SUMMARY: { tone: "private" | "public" | "never"; head: string; body: string }[] = [
  {
    tone: "private",
    head: "Kept private",
    body: "Your email, your password hash, and your home pin unless you publish it.",
  },
  {
    tone: "public",
    head: "Visible to others",
    body: "Your handle, your display name and photo — and your live position only while you switch it on.",
  },
  {
    tone: "never",
    head: "Never collected",
    body: "No address, no phone, no analytics, no tracking, and nothing about how you use the app.",
  },
];

/** The one-line promise the checkbox is attached to. */
export const CONSENT_STATEMENT =
  "I have read the above and I agree to WeatherTS collecting and using the data it describes.";
