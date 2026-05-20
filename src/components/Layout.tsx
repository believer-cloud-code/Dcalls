import React from 'react';
import { Search, Camera, MoreVertical, MessageSquare, Phone, Settings, Users } from 'lucide-react';
import { DcallsIcon } from './DcallsIcon';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  onTabChange: (tab: any) => void;
  title: string;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export const Layout: React.FC<LayoutProps> = ({ 
  children, 
  activeTab, 
  onTabChange, 
  title,
  searchQuery,
  onSearchChange
}) => {
  const [isSearchVisible, setIsSearchVisible] = React.useState(false);

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-white font-sans overflow-hidden">
      {/* Top Bar */}
      <header className="flex flex-col bg-[#121212] border-b border-white/5">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <DcallsIcon size={18} className="text-white" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={() => {
                setIsSearchVisible(!isSearchVisible);
                if (isSearchVisible) onSearchChange('');
              }}
              className={cn(
                "p-2 rounded-full transition-colors",
                isSearchVisible ? "bg-indigo-500/20 text-indigo-400" : "hover:bg-white/5"
              )}
            >
              <Search size={20} />
            </button>
            <button className="p-2 hover:bg-white/5 rounded-full transition-colors">
              <Camera size={20} />
            </button>
            <div className="flex items-center gap-1">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 animate-pulse shadow-[0_0_15px_rgba(139,92,246,0.5)]" />
              <button className="p-2 hover:bg-white/5 rounded-full transition-colors">
                <MoreVertical size={20} />
              </button>
            </div>
          </div>
        </div>

        {/* Search Bar */}
        <AnimatePresence>
          {isSearchVisible && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="px-4 pb-3 overflow-hidden"
            >
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                <input
                  autoFocus
                  type="text"
                  placeholder={`Search ${title.toLowerCase()}...`}
                  value={searchQuery}
                  onChange={(e) => onSearchChange(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl py-2 pl-10 pr-4 text-sm focus:outline-none focus:border-indigo-500/50 transition-colors"
                />
                {searchQuery && (
                  <button 
                    onClick={() => onSearchChange('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
                  >
                    <Search size={14} className="rotate-45" />
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto pb-20">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
          className="h-full"
        >
          {children}
        </motion.div>
      </main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-[#121212]/95 backdrop-blur-lg border-t border-white/5 px-4 py-2 flex justify-between items-center z-50">
        <NavButton 
          icon={<MessageSquare size={22} />} 
          label="Chats" 
          active={activeTab === 'chats'} 
          onClick={() => onTabChange('chats')} 
        />
        <NavButton 
          icon={<Phone size={22} />} 
          label="Calls" 
          active={activeTab === 'calls'} 
          onClick={() => onTabChange('calls')} 
        />
        <NavButton 
          icon={<DcallsIcon size={24} />} 
          label="Damai" 
          active={activeTab === 'damai'} 
          onClick={() => onTabChange('damai')} 
          isSpecial
        />
        <NavButton 
          icon={<Users size={22} />} 
          label="Contacts" 
          active={activeTab === 'contacts'} 
          onClick={() => onTabChange('contacts')} 
        />
        <NavButton 
          icon={<Settings size={22} />} 
          label="Settings" 
          active={activeTab === 'settings'} 
          onClick={() => onTabChange('settings')} 
        />
      </nav>
    </div>
  );
};

interface NavButtonProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  isSpecial?: boolean;
}

const NavButton: React.FC<NavButtonProps> = ({ icon, label, active, onClick, isSpecial }) => {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1 transition-all duration-300 relative py-1 px-3 rounded-2xl",
        active ? "text-white" : "text-gray-500 hover:text-gray-300",
        isSpecial && active && "text-purple-400"
      )}
    >
      <div className={cn(
        "p-1 rounded-xl transition-all",
        active && !isSpecial && "bg-white/10",
        active && isSpecial && "bg-purple-500/20 shadow-[0_0_20px_rgba(168,85,247,0.3)]"
      )}>
        {icon}
      </div>
      <span className="text-[10px] font-medium uppercase tracking-widest">{label}</span>
      {active && (
        <motion.div 
          layoutId="nav-indicator"
          className={cn(
            "absolute -bottom-1 w-1 h-1 rounded-full",
            isSpecial ? "bg-purple-500" : "bg-white"
          )}
        />
      )}
    </button>
  );
};
