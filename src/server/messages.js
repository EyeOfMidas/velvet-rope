// What each refusal says, by error code. Every error reply is { error: code, message }; an app
// passes `messages` to the plugin to reword any of them in its own voice.
export function defaultMessages({ roles, csrfHeader }) {
  return {
    csrf: `Missing ${csrfHeader} header, or the body is not JSON`,
    not_signed_in: 'Not signed in',
    forbidden: "You don't have permission to do that",
    bad_challenge: 'Unknown or expired challenge',
    verification_failed: 'Passkey verification failed',
    removed: 'This device was removed from its group. Ask someone in the group to link it again.',

    group_creation_closed: 'Creating new groups is turned off on this server',
    invite_required: 'Creating a group on this server needs an invite link',
    invite_invalid: 'This invite link has expired or was already used',
    names_required: 'Group name and device name are required',
    label_required: 'A device name is required',

    link_not_found: 'No join request',
    link_expired: 'This join code has expired. Ask for a new one.',
    link_taken: 'This join code has already been used',
    link_forbidden: "You don't have permission to link new devices",
    link_not_claimed: 'This join request hasn’t been scanned yet',
    link_not_pending: 'This join request has already been scanned',
    profile_invalid: 'That profile isn’t accepted',
    profile_too_large: 'That profile is too large',
    bad_outcome: 'Choose what this device becomes',
    link_incomplete: 'This join request can’t be completed',
    key_not_allowed: 'This server doesn’t allow device keys',
    passkey_not_allowed: 'This server only allows device keys, not passkeys',
    already_passkey: 'This device already signs in with a passkey',

    member_not_found: 'No such member',
    device_not_found: 'No such device',
    name_required: 'A name is required',
    manage_forbidden: "You don't have permission to manage members",
    invalid_role: `Pick one of: ${roles.names.join(', ')}`,
    last_admin: 'A group needs an admin. Make someone else an admin first.',
    nothing_to_change: 'Nothing to change',

    delete_forbidden: 'Only an admin can delete the group',
    confirm_name: 'Type the group’s name to delete it',

    server_error: 'Something went wrong on our side',
    too_many_requests: 'Too many requests. Try again later.',
  };
}
