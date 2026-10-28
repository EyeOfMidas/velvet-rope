// What each refusal says, by error code. Every error reply is { error: code, message }; an app
// passes `messages` to the plugin to reword any of them in its own voice.
export function defaultMessages({ roles, csrfHeader }) {
  return {
    csrf: `Missing JSON content type or ${csrfHeader} header`,
    not_signed_in: 'Not signed in',
    forbidden: "You don't have permission to do that",
    bad_challenge: 'Unknown or expired challenge',
    verification_failed: 'Passkey verification failed',
    removed: 'This passkey was removed from its group. Ask someone in the group to link this device again.',

    group_creation_closed: 'Creating new groups is turned off on this server',
    invite_required: 'Creating a group on this server needs an invite link',
    invite_invalid: 'This invite link has expired or was already used',
    names_required: 'Group name and passkey label are required',
    label_required: 'A passkey label is required',

    link_not_found: 'No join request',
    link_expired: 'This join code has expired. Ask for a new one.',
    link_taken: 'This join code has already been used',
    link_forbidden: "You don't have permission to link new devices",
    link_not_claimed: 'This join request hasn’t been scanned yet',
    link_incomplete: 'This join request can’t be completed',

    member_not_found: 'No such member',
    manage_forbidden: "You don't have permission to manage members",
    invalid_role: `Pick one of: ${roles.names.join(', ')}`,
    last_admin: 'A group needs an admin. Make someone else an admin first.',
    nothing_to_change: 'Nothing to change',

    delete_forbidden: 'Only an admin can delete the group',
    confirm_name: 'Type the group’s name to delete it',

    too_many_requests: 'Too many requests. Try again later.',
  };
}
