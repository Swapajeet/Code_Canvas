import React, { useState, useEffect, useRef } from 'react';

import {
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  serverTimestamp,
  limit,
  doc,
  updateDoc,
  arrayUnion,
  getDoc,
  setDoc
} from 'firebase/firestore';

import { motion, AnimatePresence } from 'framer-motion';
import { Send } from 'lucide-react';

import { db } from '../lib/firebase';

// =========================================================
// TYPES
// =========================================================

interface ChatProps {
  roomId: string;
  username: string;
  userId?: string;
}

interface Message {
  id: string;
  sender: string;
  senderId: string;
  text: string;
  timestamp: any;
}

// =========================================================
// COMPONENT
// =========================================================

export default function Chat({
  roomId,
  username,
  userId
}: ChatProps) {

  // =========================================================
  // STATE
  // =========================================================

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // =========================================================
  // AUTO SCROLL
  // =========================================================

  const scrollToBottom = () => {

    if (messagesEndRef.current) {

      messagesEndRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'end'
      });
    }
  };

  useEffect(() => {

    const timeout = setTimeout(() => {
      scrollToBottom();
    }, 100);

    return () => clearTimeout(timeout);

  }, [messages]);

  // =========================================================
  // DEBUG
  // =========================================================

  useEffect(() => {

    console.log('Chat Props:', {
      roomId,
      username,
      userId
    });

  }, [roomId, username, userId]);

  // =========================================================
  // CREATE / JOIN ROOM
  // =========================================================

  useEffect(() => {

    if (!roomId) return;

    const joinRoom = async () => {

      try {

        const roomRef = doc(
          db,
          'sessions',
          roomId
        );

        const roomSnap = await getDoc(roomRef);

        // =====================================================
        // CREATE ROOM IF MISSING
        // =====================================================

        if (!roomSnap.exists()) {

          await setDoc(roomRef, {

            files: {},

            activeFile: 'main.js',

            canvas: [],

            members: [
              userId || 'anonymous'
            ],

            ownerId:
              userId || 'anonymous',

            updatedAt:
              serverTimestamp()
          });

          console.log(
            'Room created successfully'
          );

        } else {

          // ===================================================
          // JOIN EXISTING ROOM
          // ===================================================

          await updateDoc(roomRef, {

            members: arrayUnion(
              userId || 'anonymous'
            ),

            updatedAt:
              serverTimestamp()
          });

          console.log(
            'Joined existing room'
          );
        }

      } catch (error) {

        console.error(
          'Error joining room:',
          error
        );
      }
    };

    joinRoom();

  }, [roomId, userId]);

  // =========================================================
  // REALTIME MESSAGES
  // =========================================================

  useEffect(() => {

    if (!roomId) return;

    console.log(
      'Listening to room:',
      roomId
    );

    const messagesRef = collection(
      db,
      `sessions/${roomId}/messages`
    );

    const q = query(
      messagesRef,
      orderBy('timestamp', 'asc'),
      limit(100)
    );

    const unsubscribe = onSnapshot(

      q,

      (snapshot) => {

        console.log(
          'Messages count:',
          snapshot.docs.length
        );

        const newMessages = snapshot.docs
          .map((doc) => ({
            id: doc.id,
            ...doc.data()
          }))
          .filter(
            (msg: any) => msg.timestamp
          );

        console.log(
          'Realtime Messages:',
          newMessages
        );

        setMessages(
          newMessages as Message[]
        );
      },

      (error) => {

        console.error(
          'Firestore Chat Error:',
          error
        );
      }
    );

    return () => unsubscribe();

  }, [roomId]);

  // =========================================================
  // SEND MESSAGE
  // =========================================================

  const handleSend = async (
    e: React.FormEvent
  ) => {

    e.preventDefault();

    if (!input.trim()) return;
    if (!roomId) return;

    const text = input.trim();

    setInput('');

    try {

      await addDoc(

        collection(
          db,
          `sessions/${roomId}/messages`
        ),

        {
          sender:
            username || 'Anonymous',

          senderId:
            userId || 'anonymous',

          text,

          timestamp:
            serverTimestamp()
        }
      );

      console.log(
        'Message sent successfully'
      );

    } catch (error) {

      console.error(
        'Error sending message:',
        error
      );
    }
  };

  // =========================================================
  // FORMAT TIME
  // =========================================================

  const formatTime = (
    timestamp: any
  ) => {

    if (!timestamp?.toDate) {
      return '...';
    }

    return new Date(
      timestamp.toDate()
    ).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // =========================================================
  // UI
  // =========================================================

  return (

    <div className="flex flex-col h-screen w-full bg-[#020617]/40 backdrop-blur-sm">

      {/* HEADER */}

      <div className="p-4 border-b border-slate-800 bg-[#020617]/60 shrink-0">

        <h3 className="font-semibold text-sm uppercase tracking-widest text-slate-400">
          Live Chat
        </h3>

      </div>

      {/* MESSAGES */}

      <div
        ref={messagesContainerRef}
        className="
          flex-1
          overflow-y-auto
          overflow-x-hidden
          p-4
          space-y-4
          scroll-smooth
        "
        style={{
          maxHeight: '100%',
          scrollbarWidth: 'thin'
        }}
      >

        <AnimatePresence initial={false}>

          {messages.map((msg) => {

            const isOwnMessage =
              msg.senderId ===
              (userId || 'anonymous');

            return (

              <motion.div
                key={msg.id}

                initial={{
                  opacity: 0,
                  y: 10,
                  scale: 0.95
                }}

                animate={{
                  opacity: 1,
                  y: 0,
                  scale: 1
                }}

                transition={{
                  duration: 0.2
                }}

                className={`
                  flex flex-col
                  ${
                    isOwnMessage
                      ? 'items-end'
                      : 'items-start'
                  }
                `}
              >

                {/* USERNAME + TIME */}

                <div className="flex items-center gap-1.5 mb-1 px-1">

                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-tighter">
                    {msg.sender}
                  </span>

                  <span className="text-[10px] text-slate-600">
                    {formatTime(msg.timestamp)}
                  </span>

                </div>

                {/* MESSAGE */}

                <div
                  className={`
                    max-w-[85%]
                    px-3
                    py-2
                    rounded-2xl
                    text-sm
                    break-words
                    whitespace-pre-wrap

                    ${
                      isOwnMessage
                        ? `
                          bg-blue-600
                          text-white
                          rounded-tr-none
                          shadow-lg
                          shadow-blue-500/10
                        `
                        : `
                          bg-slate-800
                          text-slate-200
                          rounded-tl-none
                          border
                          border-slate-700
                        `
                    }
                  `}
                >

                  {msg.text}

                </div>

              </motion.div>
            );
          })}

        </AnimatePresence>

        {/* AUTO SCROLL TARGET */}

        <div ref={messagesEndRef} />

      </div>

      {/* INPUT */}

      <form
        onSubmit={handleSend}
        className="p-4 border-t border-slate-800 bg-[#020617]/60 shrink-0"
      >

        <div className="relative">

          <input
            type="text"

            value={input}

            onChange={(e) =>
              setInput(e.target.value)
            }

            placeholder="Type a message..."

            className="
              w-full
              bg-slate-800
              border
              border-slate-700
              rounded-xl
              pl-4
              pr-12
              py-2.5
              text-sm
              text-white
              placeholder:text-slate-500
              focus:outline-none
              focus:ring-2
              focus:ring-blue-500
              transition-all
            "
          />

          <button
            type="submit"

            className="
              absolute
              right-2
              top-1/2
              -translate-y-1/2
              p-1.5
              bg-blue-600
              text-white
              rounded-lg
              hover:bg-blue-500
              transition-colors
            "
          >

            <Send size={16} />

          </button>

        </div>

      </form>

    </div>
  );
}