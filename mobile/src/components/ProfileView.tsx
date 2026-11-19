import { useCallback, useEffect, useState } from 'react';
import { BackHandler, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { signOutUser } from '../auth/authService';
import { useAuth } from '../auth/AuthContext';
import { discardAccount } from '../data/accountData';
import { ThemedStatusBar, useAppSettings, useTheme, useThemedStyles, type Appearance, type MapDotColor } from '../theme/AppSettings';
import { ScreenTransition } from '../theme/motion';
import { lightColors } from '../theme/colors';
import { FEEDBACK_FORM_URL } from '../data/nudgePrompt';
import { openDonationPage, STUDENT_DISCLAIMER } from '../data/supportPrompt';
import { findLabeledLocation, savedPlaceGroups, sortSavedLocations, SAVED_PLACE_COLORS, type SavedLocation } from '../data/userData';
import { SAVED_PLACE_COLOR_HEX } from '../data/savedPlacePin';
import { Icon, type IconName } from './Icon';
import { SettingsPathling } from './LivelyPathling';
import { Mascot } from './Mascot';
import { OfficialMapsSettings } from './OfficialMapsSettings';
import { PressableScale } from './PressableScale';
import { Toast, type ToastMessage } from './Toast';
import { SavedPlaceBadge } from './SavedPlaceBadge';
import { savedLocationIcon, savedPlaceLines } from './SavedPlacesStrip';
import { AccessibilitySettings, AccountSettings, contactSupport, FaqSettings, InboxSettings, LegalSettings, NotificationSettings, PrivacySettings, TravelSettings } from './SettingsPages';
import { Card, ChoiceRow, createStyles, Header } from './SettingsKit';
import { BeanAvatarEditor } from '../avatars/BeanAvatarEditor';
import { DestinationPinEditor } from './DestinationPinEditor';
import { DestinationPinMarker } from './DestinationPinMarker';

type ProfileViewProps = {
  onBack: () => void;
  /** Shown only to the admin account. */
  onOpenAdminTools?: () => void;
  /** Opens straight to a settings page (back from choosing a place to save). */
  initialRoute?: 'places';
  /** The signed-in rider's saved places, managed under Saved places. */
  savedPlaces?: {
    locations: readonly SavedLocation[];
    onAdd: (label?: 'Home' | 'Work') => void;
    onEdit: (location: SavedLocation) => void;
  };
};

type SavedPlacesSettingsProps = NonNullable<ProfileViewProps['savedPlaces']>;

/**
 * Settings -> Saved places: Home and Work first (or a row to set each), then the places in no list,
 * then each list under its name, then Add.
 */
function SavedPlacesSettings({ locations, onAdd, onEdit }: SavedPlacesSettingsProps) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  // Home, then Work, always the first two rows (a saved one, or a row to set it), whatever list they're in.
  const anchors = (['Home', 'Work'] as const).map((label) => ({ label, location: findLabeledLocation(locations, label) }));
  const anchorIds = new Set(anchors.flatMap(({ location }) => (location ? [location.id] : [])));
  const sorted = sortSavedLocations(locations).filter((location) => !anchorIds.has(location.id));
  const groups = savedPlaceGroups(sorted);
  const inGroup = (location: SavedLocation, name: string) => location.address.group?.trim().toLowerCase() === name.toLowerCase();
  const row = (location: SavedLocation) => {
    const { title, subtitle } = savedPlaceLines(location);
    return (
      <PressableScale accessibilityHint="Rename, change the address, icon, color or list, or remove" accessibilityLabel={`Edit favorite ${title}`} accessibilityRole="button" key={location.id} onPress={() => onEdit(location)} style={styles.settingRow} testID={`saved-place-row-${location.id}`}>
        <SavedPlaceBadge icon={savedLocationIcon(location.address)} location={location.address} size={34} />
        <View style={styles.rowCopy}><Text numberOfLines={1} style={styles.settingText}>{title}</Text>{subtitle ? <Text numberOfLines={1} style={styles.settingDetail}>{subtitle}</Text> : null}</View>
        <Icon color={colors.mutedInk} name="forward" size={20} />
      </PressableScale>
    );
  };
  const ungrouped = sorted.filter((location) => !location.address.group?.trim());
  return (
    <>
      <Card>
        {anchors.map(({ label, location }) => location ? row(location) : (
          <PressableScale accessibilityHint={`Searches for your ${label.toLowerCase()} address`} accessibilityLabel={`Set ${label.toLowerCase()}`} accessibilityRole="button" key={label} onPress={() => onAdd(label)} style={styles.settingRow} testID={`saved-set-${label.toLowerCase()}`}>
            <View style={styles.rowIcon}><Icon name={label === 'Home' ? 'home' : 'work'} size={19} /></View>
            <View style={styles.rowCopy}><Text style={styles.settingText}>{label}</Text><Text style={styles.settingDetail}>Set location</Text></View>
            <Icon color={colors.mutedInk} name="forward" size={20} />
          </PressableScale>
        ))}
        {ungrouped.map(row)}
      </Card>
      {groups.map((group) => (
        <View key={group.name} testID={`saved-group-${group.name}`}>
          <Text style={styles.sectionLabel}>{`${group.name} (${group.count})`}</Text>
          <Card>{sorted.filter((location) => inGroup(location, group.name)).map(row)}</Card>
        </View>
      ))}
      <PressableScale accessibilityRole="button" onPress={() => onAdd()} style={styles.primaryAction} testID="add-saved-place"><Text style={styles.primaryActionText}>Add favorite</Text></PressableScale>
    </>
  );
}
type SettingsRoute = 'hub' | 'avatar' | 'pin' | 'appearance' | 'account' | 'inbox' | 'notifications' | 'accessibility' | 'privacy' | 'travel' | 'places' | 'maps' | 'faq' | 'about';

/**
 * The hub's rows, in order, as unlabeled cards: you and how the app looks and behaves, then your
 * places and data, then support. Contact, feedback and donating leave the app rather than open a page.
 */
type HubRow = { id: Exclude<SettingsRoute, 'hub' | 'avatar' | 'pin'> | 'contact' | 'feedback' | 'donate'; title: string; detail: string; icon: IconName };
const hubCards: readonly (readonly HubRow[])[] = [
  [
    { id: 'account', title: 'Account', detail: 'Your Pathling, name, email and password', icon: 'person' },
    { id: 'inbox', title: 'Inbox', detail: 'Past alerts on your Favorite Lines', icon: 'mail' },
    { id: 'appearance', title: 'Personalization', detail: 'Theme, map dot and destination pin', icon: 'appearance' },
    { id: 'notifications', title: 'Notifications', detail: 'Service alerts and lines you follow', icon: 'bell' },
  ],
  [
    { id: 'travel', title: 'Preferences', detail: 'Modes, walking and transfers', icon: 'travel' },
    { id: 'accessibility', title: 'Accessibility', detail: 'Text size, motion, contrast, step-free', icon: 'accessibility' },
    { id: 'places', title: 'Favorites', detail: 'Home, work and your lists', icon: 'favorite' },
    { id: 'maps', title: 'Offline Maps', detail: 'MTA maps, saved for offline', icon: 'map' },
  ],
  [
    { id: 'privacy', title: 'Location & Privacy', detail: 'Location and your data', icon: 'privacy' },
    { id: 'faq', title: 'FAQ', detail: 'Answers to common questions', icon: 'info' },
    { id: 'contact', title: 'Contact Us', detail: 'Email the Pathly team', icon: 'feedback' },
    { id: 'feedback', title: 'Send feedback', detail: 'Tell us what to fix or add', icon: 'edit' },
    { id: 'donate', title: 'Support Pathly', detail: STUDENT_DISCLAIMER, icon: 'heart' },
    { id: 'about', title: 'About', detail: 'Version, policies and credits', icon: 'info' },
  ],
];
/** Rows that need an account, so a guest doesn't see them. */
const ACCOUNT_ONLY_ROWS: ReadonlySet<HubRow['id']> = new Set<HubRow['id']>(['account', 'inbox', 'notifications']);
/** Page titles, from the hub's rows. */
const pageTitles: Partial<Record<SettingsRoute, string>> = Object.fromEntries(hubCards.flat().map((row) => [row.id, row.title]));

/** The home map's explore dot: the theme's purple first, then the saved-place colors. */
function MapDotColorRow({ onFeedback }: { onFeedback: (message: string) => void }) {
  const styles = useThemedStyles(createStyles);
  const { mapDotColor, setMapDotColor } = useAppSettings();
  const { colors } = useTheme();
  const options: readonly { id: MapDotColor; label: string; hex: string }[] = [
    { id: 'default', label: 'Purple (default)', hex: lightColors.searchCenter },
    ...SAVED_PLACE_COLORS.filter((color) => color !== 'purple').map((color) => ({ id: color, label: color[0]!.toUpperCase() + color.slice(1), hex: SAVED_PLACE_COLOR_HEX[color] })),
  ];
  return (
    <View style={styles.choiceBlock}>
      <Text style={styles.settingText}>Map dot color</Text>
      <Text style={styles.settingDetail}>The dot that marks where you&apos;ve moved the home map to explore.</Text>
      <View style={styles.swatches}>
        {options.map((option) => {
          const selected = mapDotColor === option.id;
          return (
            <Pressable
              accessibilityLabel={option.label}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={option.id}
              onPress={() => {
                setMapDotColor(option.id);
                onFeedback(`Map dot set to ${option.label.replace(' (default)', '').toLowerCase()}`);
              }}
              style={[styles.swatch, { backgroundColor: option.hex }, selected && { borderColor: colors.ink }]}
              testID={`map-dot-${option.id}`}
            >
              {selected ? <Icon color={colors.white} name="check" size={16} /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const appearanceOptions: readonly { label: string; value: Appearance }[] = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'System', value: 'system' },
];

export function ProfileView({ initialRoute, onBack, onOpenAdminTools, savedPlaces }: ProfileViewProps) {
  const { appearance, setAppearance } = useAppSettings();
  const { user } = useAuth();
  const guest = Boolean(user?.isAnonymous);
  // Leaving as a guest removes the throwaway session rather than leaving it behind.
  const leaveGuest = () => { if (user) void discardAccount(user); };
  const joined = user?.metadata?.creationTime ? new Date(user.metadata.creationTime) : null;
  const joinedOn = joined && Number.isFinite(joined.getTime())
    ? `Joined ${joined.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })}`
    : null;
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [route, setRoute] = useState<SettingsRoute>(initialRoute ?? 'hub');
  // Each confirmation pops up as a toast; a new id replays it even for the same words.
  const [feedback, setFeedbackMessage] = useState<ToastMessage | null>(null);
  const setFeedback = useCallback((text: string) => setFeedbackMessage(text ? { text, id: Date.now() } : null), []);
  const hideFeedback = useCallback(() => setFeedbackMessage(null), []);
  const openRoute = (nextRoute: SettingsRoute) => { setFeedback(''); setRoute(nextRoute); };
  // Android's back gesture steps back one page, like the on-screen back button: a settings page
  // returns to the hub, the hub leaves settings. The avatar and pin editors handle their own back.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route === 'avatar' || route === 'pin') return false;
      if (route === 'hub') onBack();
      else { setFeedback(''); setRoute('hub'); }
      return true;
    });
    return () => subscription.remove();
  }, [onBack, route, setFeedback]);
  const openHubRow = (id: HubRow['id']) => {
    if (id === 'contact') void contactSupport(setFeedback);
    else if (id === 'feedback') void Linking.openURL(FEEDBACK_FORM_URL).catch(() => undefined);
    else if (id === 'donate') openDonationPage();
    else openRoute(id);
  };

  if (route === 'avatar') {
    return <BeanAvatarEditor onCancel={() => openRoute('account')} onSaved={() => { openRoute('account'); setFeedback('Your Pathling is saved.'); }} />;
  }

  if (route === 'pin') {
    return <DestinationPinEditor onCancel={() => openRoute('appearance')} onSaved={() => { openRoute('appearance'); setFeedback('Your pin is saved.'); }} />;
  }

  if (route !== 'hub') {
    const title = pageTitles[route] ?? 'Settings';
    return (
      <ScreenTransition depth={1} group="settings" key={route}>
      <View style={styles.viewport}>
        <SafeAreaView edges={['top', 'bottom']} style={styles.screen} testID={`settings-${route}`}>
          <ThemedStatusBar />
          <Header onBack={() => openRoute('hub')} title={title} />
          <ScrollView contentContainerStyle={styles.pageContent} key={route} showsVerticalScrollIndicator={false}>
            {route === 'appearance' ? <><Card><ChoiceRow label="Theme" onSelect={(label) => { const option = appearanceOptions.find((item) => item.label === label); if (option) { setAppearance(option.value); setFeedback(`Appearance set to ${label}`); } }} options={appearanceOptions.map((item) => item.label)} selected={appearanceOptions.find((item) => item.value === appearance)?.label ?? 'Light'} testPrefix="appearance" /></Card><Card><MapDotColorRow onFeedback={setFeedback} /></Card><Card><PressableScale accessibilityHint="Change your destination pin's color and face" accessibilityLabel="Customize your destination pin" accessibilityRole="button" onPress={() => openRoute('pin')} style={styles.settingRow} testID="appearance-destination-pin"><DestinationPinMarker /><View style={styles.rowCopy}><Text style={styles.settingText}>Destination pin</Text><Text style={styles.settingDetail}>Marks where you&apos;re headed on trip maps.</Text></View><Icon name="forward" color={colors.mutedInk} size={20} /></PressableScale></Card></> : null}
            {route === 'account' ? <AccountSettings onEditAvatar={() => openRoute('avatar')} onFeedback={setFeedback} /> : null}
            {route === 'inbox' ? <InboxSettings /> : null}
            {route === 'notifications' ? <NotificationSettings onFeedback={setFeedback} /> : null}
            {route === 'accessibility' ? <AccessibilitySettings onFeedback={setFeedback} /> : null}
            {route === 'privacy' ? <PrivacySettings onFeedback={setFeedback} /> : null}
            {route === 'travel' ? <TravelSettings onFeedback={setFeedback} /> : null}
            {route === 'places' ? (savedPlaces ? <SavedPlacesSettings {...savedPlaces} /> : <Text style={styles.intro}>Sign in to add favorites like home and work.</Text>) : null}
            {route === 'maps' ? <OfficialMapsSettings onFeedback={setFeedback} /> : null}
            {route === 'faq' ? <FaqSettings /> : null}
            {route === 'about' ? <><View style={styles.versionCard}><Mascot size={56} style={styles.aboutMascot} /><Text style={styles.versionName}>Pathly Prototype</Text><Text style={styles.version}>Version 0.1.0</Text><Text style={styles.aboutNote} testID="about-disclaimer">{"Pathly is a free transit app built by a team of students. It isn't affiliated with or endorsed by the MTA, NYC DOT, or any transit agency, so always check posted service changes. Agency names and logos belong to their respective agencies. Tips are optional and go toward live data and server costs."}</Text></View><LegalSettings onFeedback={setFeedback} /></> : null}
          </ScrollView>
        </SafeAreaView>
        <Toast message={feedback} onHidden={hideFeedback} />
      </View>
      </ScreenTransition>
    );
  }

  return (
    <ScreenTransition depth={0} group="settings" key="hub">
    <View style={styles.viewport}>
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen} testID="profile-view">
        <ThemedStatusBar />
        <Header onBack={onBack} testID="profile-back" title="Profile & Settings" />
        <ScrollView contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}>
          <View style={styles.hero} testID="profile-hero">
            <SettingsPathling size={120} testID="profile-bean-avatar" />
            <Text numberOfLines={2} style={styles.heroName}>{guest ? 'Guest' : user?.displayName || 'Pathly Rider'}</Text>
            {guest ? <Text style={styles.heroDetail} testID="profile-guest-note">Create an account to save favorites and your Pathling</Text> : joinedOn ? <Text style={styles.heroDetail} testID="profile-since">{joinedOn}</Text> : null}
          </View>
          {hubCards.map((rows) => <View key={rows[0]!.id} style={styles.hubCard}><Card>{rows.filter((item) => !guest || !ACCOUNT_ONLY_ROWS.has(item.id)).map((item) => <PressableScale accessibilityHint={item.detail} accessibilityLabel={item.title} accessibilityRole="button" key={item.id} onPress={() => openHubRow(item.id)} style={styles.settingRow} testID={`settings-row-${item.id}`}><View style={styles.rowIcon}><Icon name={item.icon} size={19} /></View><View style={styles.rowCopy}><Text style={styles.settingText}>{item.title}</Text></View><Icon color={colors.mutedInk} name="forward" size={20} /></PressableScale>)}</Card></View>)}
          {onOpenAdminTools ? <View style={styles.hubCard}><Card><PressableScale accessibilityLabel="Admin tools" accessibilityRole="button" onPress={onOpenAdminTools} style={styles.settingRow} testID="settings-row-admin"><View style={styles.rowIcon}><Icon name="crosshair" size={19} /></View><View style={styles.rowCopy}><Text style={styles.settingText}>Admin tools</Text></View><Icon color={colors.mutedInk} name="forward" size={20} /></PressableScale></Card></View> : null}
          <PressableScale accessibilityRole="button" onPress={guest ? leaveGuest : () => { void signOutUser(); }} style={styles.signOut} testID="sign-out"><Text style={styles.signOutText}>{guest ? 'Sign in or create account' : 'Sign out'}</Text></PressableScale>
        </ScrollView>
      </SafeAreaView>
      <Toast message={feedback} onHidden={hideFeedback} />
    </View>
    </ScreenTransition>
  );
}
