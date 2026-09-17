import { randomUUID } from 'node:crypto';

export type ConferenceGrant = {
  canPublishAudio: boolean;
  canPublishVideo: boolean;
  canPublishScreen: boolean;
  canSubscribe: boolean;
};
export type ConferenceToken = {
  token: string;
  roomName: string;
  participantId: string;
  permissions: ConferenceGrant;
  expiresAt: string;
};
export interface ConferenceTokenSigner {
  sign(input: {
    roomName: string;
    participantId: string;
    identity: string;
    grants: ConferenceGrant;
    ttlSeconds: number;
  }): Promise<string>;
}

/** Adapter around LiveKit's AccessToken. Keeping it behind this port makes security tests service-only. */
export class FakeConferenceSigner implements ConferenceTokenSigner {
  readonly issued: Array<Parameters<ConferenceTokenSigner['sign']>[0]> = [];
  async sign(input: Parameters<ConferenceTokenSigner['sign']>[0]) {
    this.issued.push(input);
    return `test.${randomUUID()}`;
  }
}
export class ConferenceService {
  constructor(
    private readonly signer: ConferenceTokenSigner,
    private readonly ttlSeconds = 3600,
  ) {}
  async issue(
    roomName: string,
    participantId: string,
    isHost: boolean,
    policy: { enabled: boolean; requireHostApproval: boolean },
    grant?: Partial<ConferenceGrant>,
  ): Promise<ConferenceToken> {
    if (!Number.isInteger(this.ttlSeconds) || this.ttlSeconds < 60 || this.ttlSeconds > 3600)
      throw new Error('invalid_token_ttl');
    if (!roomName || roomName.length > 128 || !participantId || participantId.length > 128)
      throw new Error('invalid_conference_identity');
    if (!policy.enabled && !isHost) throw new Error('conference_disabled');
    const permissions: ConferenceGrant = {
      canPublishAudio: isHost || grant?.canPublishAudio === true,
      canPublishVideo: isHost || grant?.canPublishVideo === true,
      canPublishScreen: isHost || grant?.canPublishScreen === true,
      canSubscribe: true,
    };
    // Approval is enforced by the grant, never by a remote camera toggle.
    if (!isHost && policy.requireHostApproval && !grant)
        permissions.canPublishAudio = permissions.canPublishVideo = permissions.canPublishScreen = false;
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000).toISOString();
    return {
      token: await this.signer.sign({
        roomName,
        participantId,
        identity: participantId,
        grants: permissions,
        ttlSeconds: this.ttlSeconds,
      }),
      roomName,
      participantId,
      permissions,
      expiresAt,
    };
  }
}
