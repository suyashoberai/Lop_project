"use server";

import {
  IngressAudioEncodingPreset,
  IngressInput,
  IngressClient,
  IngressVideoEncodingPreset,
  RoomServiceClient,
  IngressVideoOptions,
  IngressAudioOptions,
  type CreateIngressOptions,
} from "livekit-server-sdk";
import { TrackSource } from "livekit-server-sdk";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { getSelf } from "@/lib/auth-service";

const roomService = new RoomServiceClient(
  process.env.LIVEKIT_API_URL!,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

const ingressClient = new IngressClient(process.env.LIVEKIT_API_URL!);

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

const retry = async (fn: Function, retries = 3, delayMs = 1000) => {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt < retries - 1) {
        await delay(delayMs);
      } else {
        throw error;
      }
    }
  }
};

export const resetIngresses = async (hostId: string) => {
  const ingresses = await retry(() => ingressClient.listIngress({ roomName: hostId }));
  const rooms = await retry(() => roomService.listRooms([hostId]));

  for (const room of rooms) {
    await retry(() => roomService.deleteRoom(room.name));
    await delay(200); // Avoid rapid-fire requests
  }

  for (const ingress of ingresses) {
    if (ingress.ingressId) {
      await retry(() => ingressClient.deleteIngress(ingress.ingressId));
      await delay(200);
    }
  }
};

export const createIngress = async (ingressType: IngressInput) => {
  const self = await getSelf();

  if (!self?.id || !self?.username) {
    throw new Error("User identity not available");
  }

  await resetIngresses(self.id);

  const options: CreateIngressOptions = {
    name: self.username,
    roomName: self.id,
    participantName: self.username,
    participantIdentity: self.id,
  };

  if (ingressType === IngressInput.WHIP_INPUT) {
    options.enableTranscoding = true;
  } else {
    options.video = new IngressVideoOptions({
      source: TrackSource.CAMERA,
      encodingOptions: {
        case: "preset",
        value: IngressVideoEncodingPreset.H264_1080P_30FPS_3_LAYERS,
      },
    });
    options.audio = new IngressAudioOptions({
      name: "audio",
      source: TrackSource.MICROPHONE,
      encodingOptions: {
        case: "preset",
        value: IngressAudioEncodingPreset.OPUS_STEREO_96KBPS,
      },
    });
  }

  const ingress = await retry(() => ingressClient.createIngress(ingressType, options));

  if (!ingress || !ingress.url || !ingress.streamKey) {
    throw new Error("Failed to create ingress");
  }

  await db.stream.update({
    where: {
      userId: self.id,
    },
    data: {
      ingressId: ingress.ingressId,
      serverUrl: ingress.url,
      streamKey: ingress.streamKey,
    },
  });

  revalidatePath(`/u/${self.username}/keys`);
  return ingress;
};
