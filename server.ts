import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import { spawn, ChildProcess } from "child_process";
import fs from "fs-extra";
import admin from "firebase-admin";
import { initializeApp as initializeClientApp } from "firebase/app";
import {
  getFirestore as getClientFirestore,
  doc,
  getDoc,
} from "firebase/firestore";
import pkg from "lodash";

const { debounce } = pkg;

// Firebase Config
const firebaseConfig = fs.readJsonSync(
  path.join(process.cwd(), "firebase-applet-config.json")
);

// Initialize Firebase Client SDK
const clientApp = initializeClientApp(firebaseConfig);
const clientDb = getClientFirestore(clientApp);

// Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      projectId: firebaseConfig.projectId,
    });

    console.log(
      "[Firebase Admin] Initialized Successfully:",
      firebaseConfig.projectId
    );
  } catch (error) {
    console.error(
      "[Firebase Admin] Initialization failed:",
      error
    );
  }
}

const adminDb = admin.firestore();

(async () => {
  try {
    console.log("[Firebase] Testing Firestore connection...");

    await adminDb.collection("_health_check").doc("ping").set(
      {
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        message: `Server startup check at ${new Date().toISOString()}`,
      },
      { merge: true }
    );

    console.log("[Firebase] Firestore connection SUCCESS");
  } catch (err: any) {
    console.error("[Firebase] Firestore connection FAILED");
    console.error(err);
  }
})();

const PORT = process.env.PORT || 3000;

async function startServer() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
    transports: ["websocket", "polling"],
  });

  const rooms = new Map<
    string,
    {
      files: Record<string, { content: string; language: string }>;
      activeFile: string;
      canvas: any[];
      users: Map<string, { username: string; color: string }>;
    }
  >();

  const runningProcesses = new Map<string, ChildProcess>();

  // Save Room
  const saveRoomToFirestore = debounce(async (roomId: string) => {
    const room = rooms.get(roomId);

    if (!room) return;

    try {
      await adminDb.collection("sessions").doc(roomId).set(
        {
          files: room.files,
          activeFile: room.activeFile,
          canvas: room.canvas,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (error) {
      console.error("[Firestore Save Error]", error);
    }
  }, 2000);

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on(
      "join-room",
      async ({ roomId, username, color, userId }) => {
        socket.join(roomId);

        const effectiveUserId = userId || socket.id;

        if (!rooms.has(roomId)) {
          try {
            let data: any = null;
            let exists = false;

            try {
              const docSnap = await adminDb
                .collection("sessions")
                .doc(roomId)
                .get();

              if (docSnap.exists) {
                data = docSnap.data();
                exists = true;
              }
            } catch {
              const docRef = doc(clientDb, "sessions", roomId);
              const docSnap = await getDoc(docRef);

              if (docSnap.exists()) {
                data = docSnap.data();
                exists = true;
              }
            }

            if (exists) {
              rooms.set(roomId, {
                files: data.files || {},
                activeFile: data.activeFile || "main.js",
                canvas: data.canvas || [],
                users: new Map(),
              });
            } else {
              const initialState = {
                files: {
                  "main.js": {
                    content:
                      '// Welcome to Code Canvas\nconsole.log("Hello World");',
                    language: "javascript",
                  },
                },
                activeFile: "main.js",
                canvas: [],
                users: new Map(),
              };

              rooms.set(roomId, initialState);

              await adminDb.collection("sessions").doc(roomId).set({
                files: initialState.files,
                activeFile: initialState.activeFile,
                canvas: initialState.canvas,
                members: effectiveUserId
                  ? [effectiveUserId]
                  : [],
                ownerId: effectiveUserId || null,
                updatedAt:
                  admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          } catch (error) {
            console.error("[Firestore Load Error]", error);

            rooms.set(roomId, {
              files: {
                "main.js": {
                  content: "// Error loading room",
                  language: "javascript",
                },
              },
              activeFile: "main.js",
              canvas: [],
              users: new Map(),
            });
          }
        }

        const room = rooms.get(roomId)!;

        room.users.set(socket.id, {
          username,
          color,
        });

        socket.emit("room-init", {
          files: room.files,
          activeFile: room.activeFile,
          canvas: room.canvas,
          users: Array.from(room.users.values()),
        });

        socket.to(roomId).emit("user-joined", {
          username,
          color,
          id: socket.id,
        });

        io.to(roomId).emit(
          "update-users",
          Array.from(room.users.values())
        );
      }
    );

    socket.on(
      "code-change",
      ({ roomId, files, activeFile }) => {
        const room = rooms.get(roomId);

        if (room) {
          room.files = files;
          room.activeFile = activeFile;

          socket.to(roomId).emit("code-update", {
            files,
            activeFile,
          });

          saveRoomToFirestore(roomId);
        }
      }
    );

    socket.on("send-message", ({ roomId, message }) => {
      io.to(roomId).emit("new-message", message);
    });

    socket.on("disconnecting", () => {
      for (const roomId of socket.rooms) {
        const room = rooms.get(roomId);

        if (room) {
          room.users.delete(socket.id);

          io.to(roomId).emit(
            "update-users",
            Array.from(room.users.values())
          );
        }
      }
    });
  });

  // API
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
    });
  });

  // Development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
      },
      appType: "spa",
    });

    app.use(vite.middlewares);
  }

  // Production
  else {
    const distPath = path.resolve(process.cwd(), "dist");

    console.log("DIST PATH:", distPath);
    console.log("DIST EXISTS:", fs.existsSync(distPath));

    app.use(express.static(distPath));

    app.get("*", (req, res) => {
      res.sendFile(
        path.join(distPath, "index.html")
      );
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Startup error:", err);
  process.exit(1);
});