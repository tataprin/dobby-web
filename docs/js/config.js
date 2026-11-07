// Dobby Web configuration.
// Fill both values after creating the Supabase project (see the repo README, "Supabase project").
// Supabase dashboard -> Project Settings -> API Keys:
//   SUPABASE_URL       the Project URL, e.g. "https://abcdefghijkl.supabase.co"
//   SUPABASE_ANON_KEY  the Publishable key ("sb_publishable_...") or the legacy "anon public" key (a JWT)
// Both key kinds are public by design; Row Level Security in supabase/schema.sql protects the data.
// NEVER put the secret / service_role key here.
// Leave them empty to show the setup screen (and the demo mode button).
export const SUPABASE_URL = "https://rpzuzhefviydjmeggvvz.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_208tCs0INvDHYohhl5_DGQ_ezVQkJst";
// Web Push (SPEC 9.7): the PUBLIC VAPID key (the private key stays in the Supabase secrets, never in this repo).
export const VAPID_PUBLIC_KEY = 'BCTdZs2rTz3LJdYY_Pc5dR7-q8Y2z0cenRzY-TvmusaHdcZ0NF14pnQCnVrA4Q-jwN-DkuJ5YZJ7lo5SXuDxvjk';
