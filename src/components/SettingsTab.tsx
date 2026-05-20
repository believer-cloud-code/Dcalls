import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { User, Bell, Shield, HelpCircle, LogOut, ChevronRight, Moon, Languages, X, Camera, Check, Smartphone, Lock, Eye, Volume2, Palette, Globe, ArrowLeft, Smile, Zap, MessageSquare } from 'lucide-react';
import { DcallsIcon } from './DcallsIcon';
import { authService, UnifiedUser } from '../services/authService';
import { db } from '../firebase';
import { deviceService } from '../services/deviceService';
import { doc, updateDoc } from 'firebase/firestore';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface SettingItemProps {
  icon: React.ReactNode;
  label: string;
  desc: string;
  toggle?: boolean;
  checked?: boolean;
  onChange?: (val: boolean) => void;
  onClick?: () => void;
}

const SettingItem: React.FC<SettingItemProps> = ({ icon, label, desc, toggle, checked, onChange, onClick }) => (
  <button
    onClick={onClick}
    className="w-full flex items-center gap-4 group"
  >
    <div className="p-2.5 rounded-xl bg-white/5 text-gray-400 group-hover:text-white transition-colors">
      {icon}
    </div>
    <div className="flex-1 text-left">
      <h3 className="text-sm font-semibold text-white">{label}</h3>
      <p className="text-[11px] text-gray-500 uppercase tracking-widest">{desc}</p>
    </div>
    {toggle ? (
      <div
        onClick={(e) => {
          e.stopPropagation();
          onChange?.(!checked);
        }}
        className={cn(
          "w-10 h-5 rounded-full transition-all relative cursor-pointer",
          checked ? "bg-indigo-600" : "bg-white/10"
        )}
      >
        <div className={cn(
          "absolute top-1 w-3 h-3 rounded-full bg-white transition-all",
          checked ? "left-6" : "left-1"
        )} />
      </div>
    ) : (
      <ChevronRight size={16} className="text-gray-700 group-hover:text-gray-400 transition-colors" />
    )}
  </button>
);

interface SettingsTabProps {
  user: UnifiedUser | null;
}

export const SettingsTab: React.FC<SettingsTabProps> = ({ user }) => {
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [status, setStatus] = useState('Available');
  const [isSaving, setIsSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);

  // Settings states
  const [notificationsEnabled, setNotificationsEnabled] = useState((user as any)?.settings?.notifications ?? true);
  const [darkMode, setDarkMode] = useState((user as any)?.settings?.darkMode ?? true);
  const [language, setLanguage] = useState((user as any)?.settings?.language ?? 'English');
  const [privacyLastSeen, setPrivacyLastSeen] = useState((user as any)?.settings?.privacyLastSeen ?? 'Everyone');
  const [autoTranslate, setAutoTranslate] = useState((user as any)?.settings?.autoTranslate ?? false);
  const [readReceipts, setReadReceipts] = useState((user as any)?.settings?.readReceipts ?? true);
  const [twoStepVerification, setTwoStepVerification] = useState((user as any)?.settings?.twoStepVerification ?? false);
  const [securityNotifications, setSecurityNotifications] = useState((user as any)?.settings?.securityNotifications ?? true);
  const [groupNotifications, setGroupNotifications] = useState((user as any)?.settings?.groupNotifications ?? true);
  const [notificationTone, setNotificationTone] = useState((user as any)?.settings?.notificationTone ?? 'Default');
  const [chatWallpaper, setChatWallpaper] = useState((user as any)?.settings?.chatWallpaper ?? 'Default');
  const [fontSize, setFontSize] = useState((user as any)?.settings?.fontSize ?? 'Medium');
  const [blockedContacts, setBlockedContacts] = useState<string[]>((user as any)?.settings?.blockedContacts ?? []);
  const [showBlockedList, setShowBlockedList] = useState(false);
  const [showChangeNumber, setShowChangeNumber] = useState(false);
  const [newNumber, setNewNumber] = useState('');

  const updateSetting = async (key: string, value: any) => {
    if (!user) return;
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        [`settings.${key}`]: value
      });
    } catch (error) {
      console.error(`Failed to update setting ${key}`, error);
    }
  };

  const handleSaveProfile = async () => {
    if (!user) return;
    setIsSaving(true);
    try {
      await authService.updateProfile({ displayName });
      await updateDoc(doc(db, 'users', user.uid), {
        displayName,
        status
      });
      setIsEditingProfile(false);
    } catch (error) {
      console.error("Failed to update profile", error);
    } finally {
      setIsSaving(false);
    }
  };

  const sections = [
    { icon: <User size={20} />, label: "Account", desc: "Privacy, security, change number" },
    { icon: <Languages size={20} />, label: "Translation", desc: "Default languages, AI voice" },
    { icon: <Bell size={20} />, label: "Notifications", desc: "Message, group & call tones" },
    { icon: <Moon size={20} />, label: "Appearance", desc: "Dark mode, wallpapers" },
    { icon: <Shield size={20} />, label: "Privacy", desc: "Last seen, profile photo" },
    { icon: <DcallsIcon size={20} />, label: "Damai AI", desc: "Persona, interaction style, commands" },
    { icon: <HelpCircle size={20} />, label: "Help", desc: "Help center, contact us, privacy policy" },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Profile Header */}
      <div className="p-6 flex items-center gap-4 border-b border-white/5 bg-white/[0.02]">
        <div className="w-20 h-20 rounded-[2rem] bg-gradient-to-br from-indigo-500 to-purple-600 p-1">
          <div className="w-full h-full rounded-[1.8rem] bg-[#0a0a0a] flex items-center justify-center overflow-hidden border border-white/10">
            {user?.photoURL ? (
              <img src={user.photoURL} alt="Profile" className="w-full h-full object-cover" />
            ) : (
              <span className="text-3xl font-bold">{user?.displayName?.charAt(0) || 'D'}</span>
            )}
          </div>
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-bold tracking-tight">{user?.displayName || 'User'}</h2>
          <p className="text-sm text-gray-500">{status}</p>
        </div>
        <button
          onClick={() => setIsEditingProfile(true)}
          className="p-2 hover:bg-white/5 rounded-full transition-colors text-indigo-400"
        >
          <ChevronRight size={24} />
        </button>
      </div>

      {/* Profile Edit Modal */}
      <AnimatePresence>
        {isEditingProfile && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-md z-[200] flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="w-full max-w-sm bg-[#121212] border border-white/10 rounded-[2.5rem] overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between bg-gradient-to-r from-indigo-500/10 to-transparent">
                <h3 className="text-lg font-bold text-white">Edit Profile</h3>
                <button
                  onClick={() => setIsEditingProfile(false)}
                  className="p-2 hover:bg-white/5 rounded-xl text-gray-500 hover:text-white transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="p-8 space-y-6">
                <div className="flex flex-col items-center">
                  <div className="relative group">
                    <div className="w-24 h-24 rounded-[2rem] bg-gradient-to-br from-indigo-500 to-purple-600 p-1">
                      <div className="w-full h-full rounded-[1.8rem] bg-[#0a0a0a] flex items-center justify-center overflow-hidden border border-white/10">
                        {user?.photoURL ? (
                          <img src={user.photoURL} alt="Profile" className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-3xl font-bold">{user?.displayName?.charAt(0) || 'D'}</span>
                        )}
                      </div>
                    </div>
                    <button className="absolute bottom-0 right-0 p-2 bg-indigo-600 rounded-xl border-2 border-[#121212] text-white shadow-lg group-hover:scale-110 transition-transform">
                      <Camera size={16} />
                    </button>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest ml-1">Display Name</label>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-indigo-500 transition-colors"
                      placeholder="Your name"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest ml-1">Status</label>
                    <input
                      type="text"
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-indigo-500 transition-colors"
                      placeholder="Your status"
                    />
                  </div>
                </div>

                <button
                  onClick={handleSaveProfile}
                  disabled={isSaving}
                  className="w-full py-4 bg-white text-black rounded-2xl font-bold uppercase tracking-widest text-xs hover:bg-gray-200 transition-all active:scale-95 flex items-center justify-center gap-2"
                >
                  {isSaving ? (
                    <div className="w-4 h-4 border-2 border-black border-t-transparent animate-spin rounded-full" />
                  ) : (
                    <>
                      <Check size={16} />
                      Save Changes
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Settings List */}
      <div className="flex-1 overflow-y-auto py-4">
        {sections.map((item, i) => (
          <motion.button
            key={item.label}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.05 }}
            onClick={() => setActiveSection(item.label)}
            className="w-full flex items-center gap-4 px-6 py-4 hover:bg-white/5 transition-colors group"
          >
            <div className="p-2.5 rounded-xl bg-white/5 text-gray-400 group-hover:text-white transition-colors">
              {item.icon}
            </div>
            <div className="flex-1 text-left">
              <h3 className="text-sm font-semibold text-white">{item.label}</h3>
              <p className="text-[11px] text-gray-500 uppercase tracking-widest">{item.desc}</p>
            </div>
            <ChevronRight size={16} className="text-gray-700 group-hover:text-gray-400 transition-colors" />
          </motion.button>
        ))}

        <div className="px-6 py-8">
          <button
            onClick={() => authService.signOut()}
            className="w-full flex items-center justify-center gap-2 p-4 rounded-2xl bg-red-500/10 text-red-500 border border-red-500/20 hover:bg-red-500/20 transition-all font-bold uppercase tracking-widest text-xs"
          >
            <LogOut size={16} />
            Log Out
          </button>
        </div>
      </div>

      {/* Settings Detail Modal */}
      <AnimatePresence>
        {activeSection && (
          <motion.div
            initial={{ opacity: 0, x: '100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: '100%' }}
            className="fixed inset-0 bg-[#0a0a0a] z-[210] flex flex-col"
          >
            <div className="p-6 border-b border-white/5 flex items-center gap-4 bg-white/[0.02]">
              <button
                onClick={() => setActiveSection(null)}
                className="p-2 hover:bg-white/5 rounded-full transition-colors text-gray-400"
              >
                <ArrowLeft size={24} />
              </button>
              <h2 className="text-xl font-bold tracking-tight">{activeSection}</h2>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-8">
              {activeSection === "Account" && (
                <div className="space-y-6">
                  <SettingItem
                    icon={<Smartphone size={20} />}
                    label="Change Number"
                    desc="Migrate your account info, groups & settings"
                    onClick={() => setShowChangeNumber(true)}
                  />
                  <SettingItem
                    icon={<Lock size={20} />}
                    label="Two-step Verification"
                    desc="Add extra security to your account"
                    toggle
                    checked={twoStepVerification}
                    onChange={(val) => {
                      setTwoStepVerification(val);
                      updateSetting('twoStepVerification', val);
                    }}
                  />
                  <SettingItem
                    icon={<Shield size={20} />}
                    label="Security Notifications"
                    desc="Get notified when your security code changes"
                    toggle
                    checked={securityNotifications}
                    onChange={(val) => {
                      setSecurityNotifications(val);
                      updateSetting('securityNotifications', val);
                    }}
                  />
                </div>
              )}

              {activeSection === "Translation" && (
                <div className="space-y-6">
                  <div className="space-y-4">
                    <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em]">Default Language</h3>
                    <div className="grid grid-cols-2 gap-3">
                      {['English', 'Spanish', 'French', 'German', 'Chinese', 'Japanese'].map(lang => (
                        <button
                          key={lang}
                          onClick={() => {
                            setLanguage(lang);
                            updateSetting('language', lang);
                          }}
                          className={cn(
                            "p-4 rounded-2xl border transition-all text-sm font-medium",
                            language === lang
                              ? "bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-600/20"
                              : "bg-white/5 border-white/5 text-gray-400 hover:bg-white/10"
                          )}
                        >
                          {lang}
                        </button>
                      ))}
                    </div>
                  </div>
                  <SettingItem
                    icon={<Globe size={20} />}
                    label="Auto-translate"
                    desc="Automatically translate incoming messages"
                    toggle
                    checked={autoTranslate}
                    onChange={(val) => {
                      setAutoTranslate(val);
                      updateSetting('autoTranslate', val);
                    }}
                  />
                </div>
              )}

              {activeSection === "Notifications" && (
                <div className="space-y-6">
                  <SettingItem
                    icon={<Bell size={20} />}
                    label="Message Notifications"
                    desc="Show notifications for new messages"
                    toggle
                    checked={notificationsEnabled}
                    onChange={(val) => {
                      setNotificationsEnabled(val);
                      updateSetting('notifications', val);
                    }}
                  />
                  <div className="space-y-4">
                    <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em]">Notification Tone</h3>
                    <select
                      value={notificationTone}
                      onChange={(e) => {
                        setNotificationTone(e.target.value);
                        updateSetting('notificationTone', e.target.value);
                      }}
                      className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-indigo-500 transition-colors text-white"
                    >
                      {['Default', 'Reflection', 'Aurora', 'Crystal', 'Digital'].map(tone => (
                        <option key={tone} value={tone} className="bg-[#121212]">{tone}</option>
                      ))}
                    </select>
                  </div>
                  <SettingItem
                    icon={<Bell size={20} />}
                    label="Group Notifications"
                    desc="Show notifications for group messages"
                    toggle
                    checked={groupNotifications}
                    onChange={(val) => {
                      setGroupNotifications(val);
                      updateSetting('groupNotifications', val);
                    }}
                  />
                </div>
              )}

              {activeSection === "Appearance" && (
                <div className="space-y-6">
                  <SettingItem
                    icon={<Moon size={20} />}
                    label="Dark Mode"
                    desc="Use dark theme across the app"
                    toggle
                    checked={darkMode}
                    onChange={(val) => {
                      setDarkMode(val);
                      updateSetting('darkMode', val);
                    }}
                  />
                  <div className="space-y-4">
                    <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em]">Chat Wallpaper</h3>
                    <div className="grid grid-cols-3 gap-2">
                      {['Default', 'Classic', 'Dark', 'Nature', 'Abstract', 'Minimal'].map(wp => (
                        <button
                          key={wp}
                          onClick={() => {
                            setChatWallpaper(wp);
                            updateSetting('chatWallpaper', wp);
                          }}
                          className={cn(
                            "py-3 rounded-xl border transition-all text-[10px] font-bold uppercase tracking-widest",
                            chatWallpaper === wp
                              ? "bg-indigo-600 border-indigo-500 text-white"
                              : "bg-white/5 border-white/5 text-gray-400 hover:bg-white/10"
                          )}
                        >
                          {wp}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-4">
                    <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em]">Font Size</h3>
                    <div className="flex gap-2">
                      {['Small', 'Medium', 'Large'].map(size => (
                        <button
                          key={size}
                          onClick={() => {
                            setFontSize(size);
                            updateSetting('fontSize', size);
                          }}
                          className={cn(
                            "flex-1 py-3 rounded-xl text-xs font-bold transition-all",
                            fontSize === size
                              ? "bg-indigo-600 text-white"
                              : "bg-white/5 border border-white/5 text-gray-400 hover:bg-white/10"
                          )}
                        >
                          {size}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {activeSection === "Privacy" && (
                <div className="space-y-6">
                  <div className="space-y-4">
                    <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em]">Who can see my last seen</h3>
                    <div className="space-y-2">
                      {['Everyone', 'My Contacts', 'Nobody'].map(option => (
                        <button
                          key={option}
                          onClick={() => {
                            setPrivacyLastSeen(option);
                            updateSetting('privacyLastSeen', option);
                          }}
                          className={cn(
                            "w-full p-4 rounded-2xl border transition-all text-left flex items-center justify-between",
                            privacyLastSeen === option
                              ? "bg-indigo-600/10 border-indigo-500/50 text-white"
                              : "bg-white/5 border-white/5 text-gray-400 hover:bg-white/10"
                          )}
                        >
                          <span className="text-sm font-medium">{option}</span>
                          {privacyLastSeen === option && <Check size={16} className="text-indigo-400" />}
                        </button>
                      ))}
                    </div>
                  </div>
                  <SettingItem
                    icon={<Eye size={20} />}
                    label="Read Receipts"
                    desc="If turned off, you won't send or receive read receipts"
                    toggle
                    checked={readReceipts}
                    onChange={(val) => {
                      setReadReceipts(val);
                      updateSetting('readReceipts', val);
                    }}
                  />
                  <SettingItem
                    icon={<Lock size={20} />}
                    label="Blocked Contacts"
                    desc="Manage contacts you've blocked"
                    onClick={() => setShowBlockedList(true)}
                  />
                </div>
              )}

              {activeSection === "Damai AI" && (
                <div className="space-y-8">
                  <div className="space-y-4">
                    <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em]">Interaction Persona</h3>
                    <div className="space-y-3">
                      {[
                        { id: 'professional', name: 'Professional Assistant', desc: 'Formal, structured, and highly efficient.', icon: <Shield size={18} /> },
                        { id: 'friendly', name: 'Friendly Companion', desc: 'Warm, empathetic, and conversational.', icon: <Smile size={18} /> },
                        { id: 'concise', name: 'Concise Expert', desc: 'Brief, direct, and data-driven.', icon: <Zap size={18} /> }
                      ].map(p => (
                        <button
                          key={p.id}
                          onClick={async () => {
                            if (!user) return;
                            await updateDoc(doc(db, 'users', user.uid), {
                              'settings.damaiPersona': p.id
                            });
                            // Force re-render or update local state if needed
                            setActiveSection("Damai AI"); // Refresh
                          }}
                          className={cn(
                            "w-full p-4 rounded-2xl border transition-all text-left flex items-start gap-4",
                            (user as any)?.settings?.damaiPersona === p.id || (!(user as any)?.settings?.damaiPersona && p.id === 'professional')
                              ? "bg-indigo-600/10 border-indigo-500/50 text-white"
                              : "bg-white/5 border-white/5 text-gray-400 hover:bg-white/10"
                          )}
                        >
                          <div className={cn(
                            "p-2 rounded-xl",
                            (user as any)?.settings?.damaiPersona === p.id ? "bg-indigo-600 text-white" : "bg-white/5"
                          )}>
                            {p.icon}
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-bold">{p.name}</span>
                              {(user as any)?.settings?.damaiPersona === p.id && <Check size={16} className="text-indigo-400" />}
                            </div>
                            <p className="text-[10px] text-gray-500 mt-0.5">{p.desc}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em]">Translation & Voice</h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <label className="text-[10px] text-gray-500 uppercase ml-1">Input Language</label>
                        <select
                          value={(user as any)?.settings?.damaiInputLang || 'English'}
                          onChange={async (e) => {
                            if (!user) return;
                            await updateDoc(doc(db, 'users', user.uid), {
                              'settings.damaiInputLang': e.target.value
                            });
                            setActiveSection("Damai AI");
                          }}
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-indigo-500/50"
                        >
                          {['English', 'Spanish', 'French', 'German', 'Chinese', 'Japanese', 'Korean', 'Portuguese', 'Russian', 'Italian'].map(lang => (
                            <option key={lang} value={lang} className="bg-[#121212]">{lang}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] text-gray-500 uppercase ml-1">Output Language</label>
                        <select
                          value={(user as any)?.settings?.damaiOutputLang || 'English'}
                          onChange={async (e) => {
                            if (!user) return;
                            await updateDoc(doc(db, 'users', user.uid), {
                              'settings.damaiOutputLang': e.target.value
                            });
                            setActiveSection("Damai AI");
                          }}
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-indigo-500/50"
                        >
                          {['English', 'Spanish', 'French', 'German', 'Chinese', 'Japanese', 'Korean', 'Portuguese', 'Russian', 'Italian'].map(lang => (
                            <option key={lang} value={lang} className="bg-[#121212]">{lang}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <SettingItem
                      icon={<Volume2 size={20} />}
                      label="Voice Output"
                      desc="Damai will speak its responses"
                      toggle={true}
                      checked={(user as any)?.settings?.damaiVoiceOutput ?? false}
                      onChange={async (val) => {
                        if (!user) return;
                        await updateDoc(doc(db, 'users', user.uid), {
                          'settings.damaiVoiceOutput': val
                        });
                      }}
                    />
                  </div>

                  <div className="p-4 bg-indigo-600/10 rounded-2xl border border-indigo-500/20 space-y-3">
                    <div className="flex items-center gap-2 text-indigo-400">
                      <DcallsIcon size={16} />
                      <h4 className="text-[10px] font-bold uppercase tracking-widest">Pro Tip: Inline Commands</h4>
                    </div>
                    <p className="text-[11px] text-gray-400 leading-relaxed">
                      Type <code className="text-indigo-300">@Damai</code> followed by a command in any chat:
                    </p>
                    <ul className="space-y-2">
                      <li className="text-[10px] text-gray-500 flex items-center gap-2">
                        <div className="w-1 h-1 rounded-full bg-indigo-500" />
                        <span><code className="text-gray-300">summarize</code> - Get a quick chat summary</span>
                      </li>
                      <li className="text-[10px] text-gray-500 flex items-center gap-2">
                        <div className="w-1 h-1 rounded-full bg-indigo-500" />
                        <span><code className="text-gray-300">reminder [task] [time]</code> - Set a task alert</span>
                      </li>
                      <li className="text-[10px] text-gray-500 flex items-center gap-2">
                        <div className="w-1 h-1 rounded-full bg-indigo-500" />
                        <span><code className="text-gray-300">poll [question] | [options]</code> - Start a vote</span>
                      </li>
                    </ul>
                  </div>
                </div>
              )}

              {activeSection === "Help" && (
                <div className="space-y-6">
                  <SettingItem
                    icon={<HelpCircle size={20} />}
                    label="Help Center"
                    desc="Get help with Dcalls features"
                    onClick={() => window.open('/help.HTML', '_blank')}
                  />
                  <SettingItem
                    icon={<MessageSquare size={20} />}
                    label="Contact Us"
                    desc="Send a message to our support team"
                    onClick={() => window.location.href = 'mailto:support@dcalls.com'}
                  />
                  <SettingItem
                    icon={<Shield size={20} />}
                    label="Privacy Policy"
                    desc="Read our terms and privacy policy"
                    onClick={() => window.open('https://dcalls.com/privacy', '_blank')}
                  />
                  <div className="p-4 bg-white/5 rounded-2xl border border-white/10">
                    <p className="text-[10px] text-gray-500 leading-relaxed text-center">
                      Dcalls uses end-to-end encryption to keep your messages secure. Only you and the person you're communicating with can read them.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Blocked Contacts Modal */}
      <AnimatePresence>
        {showBlockedList && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-md z-[200] flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="w-full max-w-md bg-[#121212] border border-white/10 rounded-[2.5rem] overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between">
                <h3 className="text-lg font-bold">Blocked Contacts</h3>
                <button onClick={() => setShowBlockedList(false)} className="p-2 hover:bg-white/5 rounded-xl text-gray-500">
                  <X size={20} />
                </button>
              </div>
              <div className="p-6 space-y-4 max-h-[400px] overflow-y-auto">
                {blockedContacts.length === 0 ? (
                  <div className="text-center py-10 space-y-2">
                    <Shield size={40} className="mx-auto text-gray-600" />
                    <p className="text-sm text-gray-500">No blocked contacts</p>
                  </div>
                ) : (
                  blockedContacts.map(contactId => (
                    <div key={contactId} className="flex items-center justify-between p-4 bg-white/5 rounded-2xl">
                      <span className="text-sm font-medium">{contactId}</span>
                      <button
                        onClick={async () => {
                          const newList = blockedContacts.filter(id => id !== contactId);
                          setBlockedContacts(newList);
                          await updateSetting('blockedContacts', newList);
                        }}
                        className="text-xs font-bold text-red-400 uppercase tracking-widest px-3 py-1 hover:bg-red-400/10 rounded-lg transition-colors"
                      >
                        Unblock
                      </button>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Change Number Modal */}
      <AnimatePresence>
        {showChangeNumber && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-md z-[200] flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="w-full max-w-md bg-[#121212] border border-white/10 rounded-[2.5rem] overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between">
                <h3 className="text-lg font-bold">Change Number</h3>
                <button onClick={() => setShowChangeNumber(false)} className="p-2 hover:bg-white/5 rounded-xl text-gray-500">
                  <X size={20} />
                </button>
              </div>
              <div className="p-8 space-y-6">
                <div className="space-y-4">
                  <p className="text-xs text-gray-400 leading-relaxed">
                    Changing your phone number will migrate your account info, groups and settings.
                  </p>
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">New Phone Number</label>
                    <input
                      type="tel"
                      value={newNumber}
                      onChange={(e) => setNewNumber(e.target.value)}
                      placeholder="+1 234 567 8900"
                      className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-4 text-sm text-white focus:outline-none focus:border-indigo-500/50"
                    />
                  </div>
                </div>
                <button
                  onClick={async () => {
                    if (!newNumber.trim()) return;
                    if (user) {
                      await updateDoc(doc(db, 'users', user.uid), {
                        phoneNumber: newNumber.trim()
                      });
                      alert("Phone number updated successfully!");
                      setShowChangeNumber(false);
                      setNewNumber('');
                    }
                  }}
                  className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-bold uppercase tracking-widest text-xs hover:bg-indigo-500 transition-all active:scale-95 shadow-lg shadow-indigo-600/20"
                >
                  Change Number
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="p-8 text-center space-y-4">
        <div className="flex flex-col gap-2">
          <div className="inline-flex items-center justify-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-[10px] text-gray-400 font-bold uppercase tracking-widest">
            Platform: <span className="text-indigo-400">{deviceService.getPlatform()}</span>
          </div>
          <div className="inline-flex items-center justify-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-[10px] text-gray-400 font-bold uppercase tracking-widest">
            Auth: <span className={cn(
              authService.getCurrentProvider() === 'firebase' ? "text-emerald-400" : "text-amber-400"
            )}>
              {authService.getCurrentProvider()}
            </span>
          </div>
        </div>
        <div>
          <p className="text-[10px] text-gray-600 font-bold uppercase tracking-[0.4em]">Dcalls v1.0.0</p>
          <p className="text-[9px] text-gray-700 mt-1">Powered by Damai AI</p>
        </div>
      </div>
    </div>
  );
};
