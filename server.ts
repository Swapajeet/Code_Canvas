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
  serverTimestamp
} from "firebase/firestore";
import pkg from 'lodash';
const { debounce } = pkg;

// Use readJsonSync for safer configuration loading
const firebaseConfig = fs.readJsonSync(path.join(process.cwd(), "firebase-applet-config.json"));

// Initialize Client SDK as a fallback for public reads if Admin SDK is restricted
const clientApp = initializeClientApp(firebaseConfig);
const clientDb = getClientFirestore(clientApp);

// Initialize Firebase Admin once
if (!admin.apps.length) {

  try {

    import serviceAccount from "./serviceAccountKey.json";

    admin.initializeApp({
      credential: admin.credential.cert(
        serviceAccount as admin.ServiceAccount
      ),
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

// Startup connection test
(async () => {
  try {
    console.log(`[Firebase] Testing Firestore connection via Admin SDK...`);
    // Using simple path to avoid rule conflicts
    await adminDb.collection('_health_check').doc('ping').set({ 
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      message: `Server startup check at ${new Date().toISOString()}`
    }, { merge: true });
    console.log(`[Firebase] Firestore connection test SUCCESS`);
  } catch (err: any) {
    console.error(`[Firebase] Firestore connection test FAILED.`);
    console.error(`[Firebase] Error code: ${err.code}, Message: ${err.message}`);
    console.error(`[Firebase] Full Error Trace:`, err);
    
    // If Admin SDK fails, try to see if it's a project ID mismatch
    console.log(`[Firebase] Config Project ID: ${firebaseConfig.projectId}`);
  }
})();

const PORT = 3000;

async function startServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
  });

  // Track room state in memory for real-time reactivity
  const rooms = new Map<string, {
    files: Record<string, { content: string; language: string }>;
    activeFile: string;
    canvas: any[];
    users: Map<string, { username: string; color: string }>;
  }>();

  const runningProcesses = new Map<string, ChildProcess>();

  // Firestore persistence helpers
  const saveRoomToFirestore = debounce(async (roomId: string) => {
    const room = rooms.get(roomId);
    if (!room || !roomId) return;

    try {
      // Validate data before saving to prevent crashes
      const roomData = {
        files: room.files || {},
        activeFile: room.activeFile || "main.js",
        canvas: room.canvas || [],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      await adminDb.collection("sessions").doc(roomId).set(roomData, { merge: true });
    } catch (error) {
      console.error(`[Firestore Save Error] Session: ${roomId}:`, error);
    }
  }, 2000);

  io.on("connection", (socket) => {
    socket.on("join-room", async ({ roomId, username, color, userId }) => {
      socket.join(roomId);
      
      const effectiveUserId = userId || socket.id;
      
      if (!rooms.has(roomId)) {
        // Try to load from Firestore
        try {
          let data: any = null;
          let exists = false;

          try {
            const docSnap = await adminDb.collection("sessions").doc(roomId).get();
            if (docSnap.exists) {
              data = docSnap.data();
              exists = true;
            }
          } catch (adminError) {
            console.warn(`[Firebase Admin] Could not load session ${roomId}, trying Client SDK fallback...`);
            // Fallback to Client SDK for public 'get'
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
              users: new Map()
            });
            
            // Manage members list for security rules
            if (effectiveUserId) {
              try {
                await adminDb.collection("sessions").doc(roomId).update({
                  members: admin.firestore.FieldValue.arrayUnion(effectiveUserId),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
              } catch (updateError) {
                console.error("[Firebase Admin] Failed to update members list:", updateError);
              }
            }
          } else {
            // New room default state
            const initialState = {
              files: {
                "main.js": { 
                  content: "// Welcome to Code Canvas\nconst readline = require(\"readline\").createInterface({\n  input: process.stdin,\n  output: process.stdout\n});\n\nreadline.question(\"What is your name? \", name => {\n  console.log(`Hello, ${name}!`);\n  readline.close();\n});", 
                  language: "javascript" 
                }
              },
              activeFile: "main.js",
              canvas: [],
              users: new Map()
            };
            rooms.set(roomId, initialState);
            
            // Create in Firestore
            await adminDb.collection("sessions").doc(roomId).set({
              files: initialState.files,
              activeFile: initialState.activeFile,
              canvas: initialState.canvas,
              members: effectiveUserId ? [effectiveUserId] : [],
              ownerId: effectiveUserId || null,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        } catch (error) {
          console.error(`[Firestore Load Error] Session: ${roomId}:`, error);
          if (!rooms.has(roomId)) {
              rooms.set(roomId, {
                files: { "main.js": { content: "// Error loading room, started with blank file", language: "javascript" } },
                activeFile: "main.js",
                canvas: [],
                users: new Map()
              });
          }
        }
      }

      const room = rooms.get(roomId)!;
      room.users.set(socket.id, { username, color });
      
      socket.emit("room-init", {
        files: room.files,
        activeFile: room.activeFile,
        canvas: room.canvas,
        users: Array.from(room.users.values())
      });

      socket.to(roomId).emit("user-joined", { username, color, id: socket.id });
      io.to(roomId).emit("update-users", Array.from(room.users.values()));
    });

    socket.on("terminal-input", async ({ roomId, input }) => {
      const room = rooms.get(roomId);
      if (!room) return;

      const proc = runningProcesses.get(roomId);
      if (proc && proc.stdin) {
        proc.stdin.write(input + "\n");
      } else {
        try {
          const projectDir = path.join(process.cwd(), "temp", roomId);
          await fs.ensureDir(projectDir);
          
          const cmdParts = input.trim().split(" ");
          if (cmdParts[0]) {
            const newProc = spawn(cmdParts[0], cmdParts.slice(1), { 
              cwd: projectDir, 
              shell: true 
            });
            runningProcesses.set(roomId, newProc);

            const emitOutput = (output: string) => io.to(roomId).emit("terminal-output", { output });
            emitOutput(`\r\n> ${input}\r\n`);
            
            newProc.stdout.on("data", (d) => emitOutput(d.toString()));
            newProc.stderr.on("data", (d) => emitOutput(d.toString()));
            newProc.on("close", (c) => {
              runningProcesses.delete(roomId);
              emitOutput(`\r\n> Process exited with code ${c}\r\n`);
            });
          }
        } catch (err: any) {
          io.to(roomId).emit("terminal-output", { output: `\r\nError executing command: ${err.message}\r\n` });
        }
      }
    });

    socket.on("code-change", ({ roomId, files, activeFile }) => {
      const room = rooms.get(roomId);
      if (room) {
        room.files = files;
        room.activeFile = activeFile;
        socket.to(roomId).emit("code-update", { files, activeFile });
        saveRoomToFirestore(roomId);
      }
    });

    socket.on("canvas-change-bulk", ({ roomId, elements }) => {
      const room = rooms.get(roomId);
      if (room && elements) {
        room.canvas = elements;
        socket.to(roomId).emit("room-init", { canvas: elements });
        saveRoomToFirestore(roomId);
      }
    });

    socket.on("canvas-change", ({ roomId, drawingData }) => {
      const room = rooms.get(roomId);
      if (room && drawingData) {
        // If the drawingData has an ID, check if it already exists to update it
        const index = room.canvas.findIndex(el => el && el.id === drawingData.id);
        if (index === -1) {
          room.canvas.push(drawingData);
        } else {
          room.canvas[index] = drawingData;
        }
        
        socket.to(roomId).emit("canvas-update", drawingData);
        saveRoomToFirestore(roomId);
      }
    });

    socket.on("canvas-element-delete", ({ roomId, elementId }) => {
      const room = rooms.get(roomId);
      if (room && elementId) {
        room.canvas = room.canvas.filter(el => el && el.id !== elementId);
        socket.to(roomId).emit("canvas-element-delete", elementId);
        saveRoomToFirestore(roomId);
      }
    });

    socket.on("canvas-clear", (roomId) => {
      const room = rooms.get(roomId);
      if (room) {
        room.canvas = [];
        io.to(roomId).emit("canvas-cleared");
        saveRoomToFirestore(roomId);
      }
    });

    socket.on("send-message", ({ roomId, message }) => {
      io.to(roomId).emit("new-message", message);
    });

    socket.on("disconnecting", () => {
      for (const roomId of socket.rooms) {
        const room = rooms.get(roomId);
        if (room) {
          room.users.delete(socket.id);
          io.to(roomId).emit("update-users", Array.from(room.users.values()));
        }
      }
    });
  });

  const syncFilesToDisk = async (roomId: string, files: Record<string, { content: string }>) => {
    const projectDir = path.join(process.cwd(), "temp", roomId);
    await fs.ensureDir(projectDir);
    if (!files["package.json"]) {
      await fs.writeJson(path.join(projectDir, "package.json"), {
        name: `temp-room-${roomId}`,
        private: true,
        type: "commonjs"
      });
    }
    for (const [filePath, file] of Object.entries(files)) {
      const fullPath = path.join(projectDir, filePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, file.content);
    }
    return projectDir;
  };

  app.get("/api/health", (req, res) => res.json({ status: "ok" }));

  app.post("/api/run", async (req, res) => {
    const { roomId, command, files } = req.body;
    if (!roomId) return res.status(400).json({ error: "Room ID is required" });
    try {
      const currentFiles = files || rooms.get(roomId)?.files;
      if (!currentFiles) return res.status(404).json({ error: "No files found" });
      const projectDir = await syncFilesToDisk(roomId, currentFiles);
      const existingProc = runningProcesses.get(roomId);
      if (existingProc) { existingProc.kill(); runningProcesses.delete(roomId); }
      
      const cmdParts = (command || `node ${rooms.get(roomId)?.activeFile || 'main.js'}`).split(" ");
      const proc = spawn(cmdParts[0], cmdParts.slice(1), { cwd: projectDir, shell: true });
      runningProcesses.set(roomId, proc);

      const emitOutput = (output: string) => io.to(roomId).emit("terminal-output", { output });
      emitOutput(`\r\n> Starting: ${cmdParts.join(" ")}\r\n`);
      proc.stdout.on("data", (d) => emitOutput(d.toString()));
      proc.stderr.on("data", (d) => emitOutput(d.toString()));
      proc.on("close", (c) => {
        runningProcesses.delete(roomId);
        emitOutput(`\r\n> Process exited with code ${c}\r\n`);
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Startup error:", err);
  process.exit(1);
});
