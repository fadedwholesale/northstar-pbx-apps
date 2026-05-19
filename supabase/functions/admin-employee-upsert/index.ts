import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type EmployeePayload = {
  email?: string;
  password?: string;
  name: string;
  extension: string;
  twilioIdentity: string;
  smsNumberE164?: string;
  notifyUser?: boolean;
  voiceEdge?: string;
};

function requiredEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v || !String(v).trim()) throw new Error(`Missing required env var: ${name}`);
  return String(v).trim();
}

function normalizeE164(v: string): string {
  const s = String(v || "").trim();
  if (!s) return "";
  if (s.startsWith("+")) return s;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return `+${d}`;
}

function randomTempPassword(): string {
  return `Ns-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}!`;
}

function truthy(v: unknown, fallback = true): boolean {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (!s) return fallback;
  if (s === "false" || s === "0" || s === "no") return false;
  return true;
}

function recycledEmailFor(originalEmail: string): string {
  const email = String(originalEmail || "").trim().toLowerCase();
  const local = (email.split("@")[0] || "user").replace(/[^a-z0-9._+-]/g, "") || "user";
  return `recycled+${Date.now()}-${local}@northstar.invalid`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const payload = (await req.json()) as EmployeePayload;
    const email = String(payload.email || "").trim().toLowerCase();
    const password = String(payload.password || "").trim();
    const name = String(payload.name || "").trim();
    const extension = String(payload.extension || "").trim();
    const twilioIdentity = String(payload.twilioIdentity || "").trim();
    const voiceEdgeRaw = String(payload.voiceEdge || "auto").trim().toLowerCase();
    const voiceEdge = voiceEdgeRaw && voiceEdgeRaw !== "auto" ? voiceEdgeRaw : null;
    const smsNumberE164 = normalizeE164(String(payload.smsNumberE164 || ""));
    const notifyUser = truthy(payload.notifyUser, true);

    if (!name || !extension || !twilioIdentity) {
      throw new Error("name, extension, and twilioIdentity are required");
    }

    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Lookup existing profile by Twilio identity.
    const profileLookup = await admin
      .from("northstar_profiles")
      .select("id,email,display_name,extension,twilio_client_identity,sms_number_e164")
      .eq("twilio_client_identity", twilioIdentity)
      .maybeSingle();
    if (profileLookup.error) throw profileLookup.error;
    let userId = profileLookup.data?.id || "";
    let createdUser = false;
    let notified = false;
    let notifyWarning = "";
    let targetEmail = email || String(profileLookup.data?.email || "").trim().toLowerCase();

    // If email provided, resolve or create auth user.
    // When a seat is already linked by Twilio identity, keep that linkage stable.
    // This avoids unique collisions on northstar_profiles.twilio_client_identity.
    if (email) {
      const list = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (list.error) throw list.error;
      const found = (list.data?.users || []).find((u) => String(u.email || "").toLowerCase() === email);
      if (found) {
        if (userId && found.id !== userId) {
          const linkedSeat = await admin
            .from("northstar_team_members")
            .select("id")
            .eq("profile_id", found.id)
            .limit(1)
            .maybeSingle();
          if (linkedSeat.error) throw linkedSeat.error;
          if (linkedSeat.data?.id) {
            throw new Error(`Email ${email} is still assigned to another seat. Remove it there first, then retry.`);
          }
          const recycled = recycledEmailFor(email);
          const release = await admin.auth.admin.updateUserById(found.id, {
            email: recycled,
            user_metadata: { released_email: email },
          });
          if (release.error) throw release.error;
          notifyWarning = `Reassigned ${email} from an unlinked legacy login.`;
          targetEmail = email;
        } else {
          userId = found.id;
          targetEmail = String(found.email || targetEmail || "").trim().toLowerCase();
        }
      } else {
        if (userId) {
          // Existing linked seat: update the linked auth user's email.
          const updated = await admin.auth.admin.updateUserById(userId, {
            email,
            user_metadata: { full_name: name },
          });
          if (updated.error) throw updated.error;
          targetEmail = String(updated.data.user?.email || email).trim().toLowerCase();
        } else {
          if (password) {
            const created = await admin.auth.admin.createUser({
              email,
              password,
              email_confirm: true,
              user_metadata: { full_name: name },
            });
            if (created.error) throw created.error;
            userId = created.data.user.id;
            createdUser = true;
            targetEmail = String(created.data.user.email || email).trim().toLowerCase();
          } else {
            // New seat without password: invite sends account setup email flow.
            const invited = await admin.auth.admin.inviteUserByEmail(email, {
              data: { full_name: name },
            });
            if (invited.error) throw invited.error;
            userId = invited.data.user.id;
            createdUser = true;
            notified = true;
          }
        }
      }
    }

    if (!userId) {
      throw new Error("No linked auth user found. Provide email/password for first-time employee signup.");
    }

    // Keep auth login synced to chosen email/password.
    const authUpdate: { email?: string; password?: string; user_metadata?: Record<string, unknown> } = {
      user_metadata: { full_name: name },
    };
    if (targetEmail) authUpdate.email = targetEmail;
    if (password) authUpdate.password = password;
    const authSync = await admin.auth.admin.updateUserById(userId, authUpdate);
    if (authSync.error) throw authSync.error;
    targetEmail = String(authSync.data.user?.email || targetEmail || "").trim().toLowerCase();

    const oldProfile = profileLookup.data;
    const emailChanged =
      String(oldProfile?.email || "").trim().toLowerCase() !== String(targetEmail || "").trim().toLowerCase();
    const phoneChanged =
      normalizeE164(String(oldProfile?.sms_number_e164 || "")) !== normalizeE164(String(smsNumberE164 || ""));
    const changedProfile = !!(
      !oldProfile ||
      String(oldProfile.display_name || "") !== name ||
      String(oldProfile.extension || "") !== extension ||
      String(oldProfile.twilio_client_identity || "") !== twilioIdentity ||
      phoneChanged ||
      emailChanged
    );

    // Upsert profile linkage.
    const profileUp = await admin.from("northstar_profiles").upsert(
      {
        id: userId,
        email: targetEmail || "",
        display_name: name,
        extension,
        twilio_client_identity: twilioIdentity,
        sms_number_e164: smsNumberE164 || null,
        voice_edge: voiceEdge,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (profileUp.error) throw profileUp.error;

    const oldTwilio = String(oldProfile?.twilio_client_identity || "").trim();
    const ownershipKeys = new Set<string>();
    if (userId) ownershipKeys.add(userId);
    if (twilioIdentity) ownershipKeys.add(twilioIdentity);
    if (oldTwilio) ownershipKeys.add(oldTwilio);

    // Keep display name on assigned leads in sync when a rep is renamed (does not change assignment id).
    for (const key of ownershipKeys) {
      const touchContacts = await admin
        .from("northstar_contacts")
        .update({ assigned_agent_name: name, updated_at: new Date().toISOString() })
        .eq("assigned_agent_id", key);
      if (touchContacts.error) throw touchContacts.error;

      const touchListItems = await admin
        .from("northstar_call_list_items")
        .update({ assigned_agent_name: name, updated_at: new Date().toISOString() })
        .eq("assigned_agent_id", key);
      if (touchListItems.error) throw touchListItems.error;
    }

    // If Twilio identity changed, migrate legacy assigned_agent_id on leads to the stable auth user id.
    if (oldTwilio && twilioIdentity && oldTwilio !== twilioIdentity && userId) {
      const migrateContacts = await admin
        .from("northstar_contacts")
        .update({
          assigned_agent_id: userId,
          assigned_agent_name: name,
          updated_at: new Date().toISOString(),
        })
        .eq("assigned_agent_id", oldTwilio);
      if (migrateContacts.error) throw migrateContacts.error;

      const migrateItems = await admin
        .from("northstar_call_list_items")
        .update({
          assigned_agent_id: userId,
          assigned_agent_name: name,
          updated_at: new Date().toISOString(),
        })
        .eq("assigned_agent_id", oldTwilio);
      if (migrateItems.error) throw migrateItems.error;
    }

    // Keep roster linkage in sync: one auth profile per seat.
    const clearRosterLink = await admin
      .from("northstar_team_members")
      .update({ profile_id: null, login_email: null, updated_at: new Date().toISOString() })
      .eq("profile_id", userId)
      .neq("twilio_client_identity", twilioIdentity);
    if (clearRosterLink.error) throw clearRosterLink.error;

    const setRosterLink = await admin
      .from("northstar_team_members")
      .update({
        profile_id: userId,
        login_email: targetEmail || null,
        updated_at: new Date().toISOString(),
      })
      .eq("twilio_client_identity", twilioIdentity);
    if (setRosterLink.error) throw setRosterLink.error;

    // Assign/unassign number inventory.
    if (smsNumberE164) {
      const clearOtherForUser = await admin
        .from("northstar_phone_numbers")
        .update({ assigned_profile_id: null, assigned_agent_id: null, updated_at: new Date().toISOString() })
        .eq("assigned_profile_id", userId)
        .neq("e164", smsNumberE164);
      if (clearOtherForUser.error) throw clearOtherForUser.error;

      const clearOtherForAgentLegacy = twilioIdentity && twilioIdentity !== userId
        ? await admin
          .from("northstar_phone_numbers")
          .update({ assigned_profile_id: null, assigned_agent_id: null, updated_at: new Date().toISOString() })
          .eq("assigned_agent_id", twilioIdentity)
          .neq("e164", smsNumberE164)
        : null;
      if (clearOtherForAgentLegacy?.error) throw clearOtherForAgentLegacy.error;

      const clearOtherForAgentUuid = await admin
        .from("northstar_phone_numbers")
        .update({ assigned_profile_id: null, assigned_agent_id: null, updated_at: new Date().toISOString() })
        .eq("assigned_agent_id", userId)
        .neq("e164", smsNumberE164);
      if (clearOtherForAgentUuid.error) throw clearOtherForAgentUuid.error;

      const set = await admin
        .from("northstar_phone_numbers")
        .update({
          assigned_profile_id: userId,
          assigned_agent_id: userId,
          updated_at: new Date().toISOString(),
        })
        .eq("e164", smsNumberE164)
        .select("e164,assigned_profile_id,assigned_agent_id")
        .maybeSingle();
      if (set.error) throw set.error;
      if (!set.data) {
        throw new Error(
          `Could not assign ${smsNumberE164}: no matching row in northstar_phone_numbers. Open the Numbers tab to sync from Twilio, then try again.`,
        );
      }
    } else {
      const clearAll = await admin
        .from("northstar_phone_numbers")
        .update({ assigned_profile_id: null, assigned_agent_id: null, updated_at: new Date().toISOString() })
        .eq("assigned_profile_id", userId);
      if (clearAll.error) throw clearAll.error;
    }

    // Existing users: send reset/setup email only for account access changes.
    // Do not send reset for phone/seat-only updates.
    const accountAccessChanged = createdUser || emailChanged || !!password;
    if (notifyUser && targetEmail && !notified && accountAccessChanged) {
      const redirectTo = Deno.env.get("EMPLOYEE_RESET_REDIRECT_URL")?.trim() || undefined;
      const rr = await admin.auth.resetPasswordForEmail(targetEmail, redirectTo ? { redirectTo } : {});
      if (rr.error) {
        notifyWarning = rr.error.message;
      } else {
        notified = true;
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        createdUser,
        userId,
        email: targetEmail || null,
        notified,
        notifyWarning: notifyWarning || null,
        changedProfile,
        linkedRosterSeat: true,
        twilioIdentity,
        smsNumberE164: smsNumberE164 || null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const errMsg =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error && "message" in error
          ? String((error as { message?: unknown }).message || "Failed to upsert employee")
          : String(error || "Failed to upsert employee");
    const errCode =
      typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code || "") : "";
    const errDetails =
      typeof error === "object" && error && "details" in error
        ? String((error as { details?: unknown }).details || "")
        : "";
    return new Response(
      JSON.stringify({
        error: errMsg,
        code: errCode || null,
        details: errDetails || null,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
