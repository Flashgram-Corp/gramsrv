-- Concurrent channel/private dialog mutations (mark-mentions-read, reaction
-- read receipts, dialog upserts) fire the dialog read-model triggers. Each
-- transaction bumps read_model_versions rows for 'dialog_light' and then
-- 'dialog_owner'; two such transactions can lock those two rows in inverted
-- order relative to the channel_dialogs / channel_unread_mentions rows they
-- already hold, producing an AB-BA deadlock (Postgres aborts one side with
-- 40P01). dialog_owner was added in 0195, widening the lock set and exposing
-- the race.
--
-- Serialize all dialog read-model writers per (owner, peer) with a
-- transaction-scoped advisory lock -- the same recipe used by the per-user
-- advisory locks in the message store. Every per-row dialog trigger funnels
-- into telesrv_bump_dialog_light, so a single lock here covers channel
-- dialogs, private dialogs, channel-membership dialog bumps and contact
-- bumps. The membership batch path keeps its deterministic ORDER BY lock
-- order (0196) and does not contend through this helper.

CREATE OR REPLACE FUNCTION public.telesrv_bump_dialog_light(
    p_owner_user_id bigint,
    p_peer_type text,
    p_peer_id bigint
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF COALESCE(p_owner_user_id, 0) = 0
       OR COALESCE(p_peer_id, 0) = 0
       OR COALESCE(p_peer_type, '') = ''
    THEN
        RETURN;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashint8(p_owner_user_id),
        hashint8(p_peer_id)
    );

    PERFORM public.telesrv_bump_read_model_version(
        'dialog_light', p_owner_user_id, p_peer_type, p_peer_id
    );
    PERFORM public.telesrv_bump_dialog_owner(p_owner_user_id);
END;
$$;