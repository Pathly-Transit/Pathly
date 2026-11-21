import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { deliverTripApproach } from '../background/tripAlertStorage';
import type { NavigationGuidance } from '../data/enrouteNavigation';
import { narratorVoice, prepareNarratorVoice } from '../data/narratorVoice';
import { announcementFor, tripNotificationContent, type AnnouncementStrength, type TripAnnouncement } from '../data/tripAnnouncements';
import type { UserPreferences } from '../data/userPreferences';
import { clearTripNotification, prepareTripNotificationPermissions, showTripNotificationAccepted } from '../lib/notifications';

/** Web has no haptics module; phones' browsers that can vibrate get a pattern instead. */
const WEB_VIBRATION: Record<AnnouncementStrength, number[]> = { step: [60], alert: [200, 120, 200], arrived: [120, 80, 120, 80, 240] };

function buzz(strength: AnnouncementStrength): boolean {
  try {
    if (Platform.OS === 'web') {
      return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function' ? navigator.vibrate(WEB_VIBRATION[strength]) : false;
    }
    if (strength === 'step') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    else void Haptics.notificationAsync(strength === 'arrived' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    return true;
  } catch {
    // No vibration on this device.
  }
  return false;
}

function stopSpeaking() {
  try {
    void Speech.stop().catch(() => undefined);
  } catch {
    // No speech engine on this device.
  }
}

function say(text: string): boolean {
  try {
    // A newer instruction replaces one still being read out.
    stopSpeaking();
    const voice = narratorVoice();
    Speech.speak(text, { language: 'en-US', ...(voice ? { voice } : {}) });
    return true;
  } catch {
    // No speech engine on this device.
  }
  return false;
}

type Options = {
  uid?: string;
  stepIndex?: number;
  /** The trip in progress, or null. */
  sessionId: string | null;
  /** Its current step (guidanceForNavigation). */
  guidance: NavigationGuidance | null;
  /** Set when a trip just completed: the trip itself ends at once, so arrival is announced from here. */
  arrivedDestination: string | null;
  settings: UserPreferences['tripGuidance'];
  /** The rider's master switch for notifications (Settings -> Notifications). */
  notificationsEnabled: boolean;
};

/**
 * Speaks and vibrates at each step of a trip, with a stronger alert the stop before getting off,
 * and keeps a notification with the current step on the lock screen until the trip ends.
 */
export function useTripGuidanceAlerts({ uid, stepIndex, sessionId, guidance, arrivedDestination, settings, notificationsEnabled }: Options) {
  const { haptics, notification, voice } = settings;
  const showsNotification = notification && notificationsEnabled;
  const guidanceKey = guidance ? `${stepIndex ?? ''}:${guidance.phase}:${JSON.stringify(tripNotificationContent(guidance))}` : null;
  // What the rider was last told, per trip, so a reopened app or a re-render doesn't repeat it.
  const last = useRef<{ sessionId: string; guidance: NavigationGuidance } | null>(null);
  // The notification last posted: the trip updates on many location fixes that change nothing shown.
  const notified = useRef<string | null>(null);
  const deliveryGeneration = useRef(0);
  const pendingApproach = useRef<{ key: string; announcement: TripAnnouncement } | null>(null);
  const acceptedApproach = useRef<string | null>(null);
  const approachPermissionAttempted = useRef(false);
  const current = useRef({ uid, sessionId, settings, showsNotification, guidanceKey });
  useLayoutEffect(() => { current.current = { uid, sessionId, settings, showsNotification, guidanceKey }; }, [uid, sessionId, settings, showsNotification, guidanceKey]);

  // The old owner stops before a replacement/arrival starts speaking. Account changes and
  // unmounts also clean up, even when this hook never renders an explicit sessionId=null.
  useEffect(() => () => {
    deliveryGeneration.current += 1;
    last.current = null;
    notified.current = null;
    pendingApproach.current = null;
    acceptedApproach.current = null;
    approachPermissionAttempted.current = false;
    stopSpeaking();
    void clearTripNotification(uid && sessionId ? { uid, sessionId } : undefined);
  }, [sessionId, uid]);

  useEffect(() => {
    if (!sessionId || !guidance) {
      last.current = null;
      return;
    }
    const previous = last.current?.sessionId === sessionId ? last.current.guidance : null;
    last.current = { sessionId, guidance };
    const nextAnnouncement = announcementFor(previous, guidance);
    if (pendingApproach.current?.key !== guidanceKey) pendingApproach.current = null;
    if (nextAnnouncement?.strength === 'alert' && guidanceKey) pendingApproach.current = { key: guidanceKey, announcement: nextAnnouncement };
    const announcement = nextAnnouncement ?? pendingApproach.current?.announcement ?? null;
    const generation = deliveryGeneration.current;
    const isCurrent = () => generation === deliveryGeneration.current && current.current.sessionId === sessionId
      && current.current.uid === uid && current.current.guidanceKey === guidanceKey;
    const deliver = async (firstWarning: boolean): Promise<boolean> => {
      if (!isCurrent()) return false;
      const approachKey = JSON.stringify([uid, sessionId, stepIndex]);
      const first = firstWarning && acceptedApproach.current !== approachKey;
      let accepted = false;
      if (announcement && (announcement.strength !== 'alert' || first)) {
        if (current.current.settings.voice) accepted = say(announcement.speech) || accepted;
        if (current.current.settings.haptics) accepted = buzz(announcement.strength) || accepted;
      }
      if (accepted && announcement?.strength === 'alert') acceptedApproach.current = approachKey;
      if (current.current.showsNotification) {
        const { title, body } = tripNotificationContent(guidance);
        const alert = announcement?.strength === 'alert' && first;
        const key = `${title}\n${body}`;
        if (alert || notified.current !== key) {
          // Track pending work too, so opt-out/end queues a dismissal behind an in-flight OS post.
          notified.current = key;
          const scheduled = await showTripNotificationAccepted(title, body, alert, {
            owner: uid ? { uid, sessionId } : undefined,
            // The shared delivery ledger must never wait on an interactive permission prompt.
            requestPermission: announcement?.strength !== 'alert', isCurrent: () => isCurrent() && current.current.showsNotification,
          });
          if (!scheduled && isCurrent() && notified.current === key) notified.current = null;
          accepted = scheduled || accepted;
          if (accepted && isCurrent() && announcement?.strength === 'alert') acceptedApproach.current = approachKey;
        }
      }
      return accepted;
    };
    if (announcement?.strength === 'alert' && uid && stepIndex != null) {
      if (!haptics && !voice && !showsNotification) return;
      void (async () => {
        if (!isCurrent()) return;
        if (current.current.showsNotification) {
          const request = !approachPermissionAttempted.current;
          approachPermissionAttempted.current = true;
          await prepareTripNotificationPermissions(request, isCurrent);
        }
        if (!isCurrent()) return;
        const result = await deliverTripApproach({ uid, sessionId }, stepIndex, deliver);
        if (isCurrent() && result && (!result.firstWarning || result.accepted)) pendingApproach.current = null;
      })().catch(() => undefined);
    } else {
      void deliver(true);
    }
  }, [guidance, guidanceKey, haptics, sessionId, showsNotification, stepIndex, uid, voice]);

  // The notification goes when the trip does, or when the rider turns it off mid-trip.
  const tripActive = sessionId != null;
  useEffect(() => {
    if ((tripActive && showsNotification) || notified.current === null) return;
    notified.current = null;
    void clearTripNotification(uid && sessionId ? { uid, sessionId } : undefined);
  }, [showsNotification, tripActive, uid, sessionId]);

  const announcedArrival = useRef<string | null>(null);
  useEffect(() => {
    if (!arrivedDestination) {
      announcedArrival.current = null;
      return;
    }
    if (announcedArrival.current === arrivedDestination) return;
    announcedArrival.current = arrivedDestination;
    if (voice) say(`You’ve arrived at ${arrivedDestination}.`);
    if (haptics) buzz('arrived');
  }, [arrivedDestination, haptics, voice]);

  // Turning the voice off mid-sentence stops it; turning it on finds the phone's best voice.
  useEffect(() => {
    if (voice) {
      prepareNarratorVoice();
      return;
    }
    stopSpeaking();
  }, [voice]);
}
