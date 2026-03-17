/**
 * Real-Time Scalable One-to-One Chat Server (Locksy)
 *
 * Architecture:
 * - userId-based routing (unique identifier per device)
 * - In-memory user mapping: userId → { socketId, isOnline, metadata }
 * - Message relay without server-side storage (client-stored only)
 * - Presence tracking with online/offline events
 * - Message acknowledgement system with delivery tracking
 * - Support for multiple simultaneous connections per user (multi-device)
 * - Room-based private messaging (io.to(receiverId).emit)
 */

import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;

// CORS configuration
const corsOptions = {
  origin: [
    "http://localhost:3000",
    "http://192.168.1.2:3000",
    "https://locksy-backend.onrender.com"
  ],
  methods: ["GET", "POST"],
};

// Use permissive CORS in development
app.use(cors());

// ─── File Upload Setup ──────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname.replace(/\s+/g, "_"));
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB limit for video (100-150 MB range)
});

app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ limit: '150mb', extended: true }));

// Serve uploads with correct video MIME and Accept-Ranges for streaming (receiver can open/seek)
app.use("/uploads", (req, res, next) => {
  const filePath = path.join(uploadDir, req.path);
  const ext = path.extname(req.path).toLowerCase();
  const videoMimes = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
  const audioMimes = { '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };
  
  if (videoMimes[ext]) {
    res.setHeader('Content-Type', videoMimes[ext]);
    res.setHeader('Accept-Ranges', 'bytes');
  } else if (audioMimes[ext]) {
    res.setHeader('Content-Type', audioMimes[ext]);
    res.setHeader('Accept-Ranges', 'bytes');
  }
  next();
}, express.static(uploadDir));

// Socket.IO server configuration
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"], // ✅ allow fallback
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 150 * 1024 * 1024, // 150MB to support large media metadata
});
// ─── In-Memory User Registry ──────────────────────────────────────────────
// userId → { socketId, isOnline, timestamp, metadata }
const userRegistry = {};

// Phone-based user registry: phoneNumber → { socketIds[], isOnline, metadata }
const phoneRegistry = {};

// Offline message queue: phoneNumber → messages[]
const offlineMessageQueue = new Map();

// Message acknowledgements tracking: messageId → acknowledged
const messageAcknowledgements = new Map();

// ─── Group Registry (Persistent) ──────────────────────────────────────────
const GROUPS_FILE = path.join(__dirname, "groups.json");
let groupRegistry = [];

function loadGroups() {
  try {
    if (fs.existsSync(GROUPS_FILE)) {
      const data = fs.readFileSync(GROUPS_FILE, "utf8");
      groupRegistry = JSON.parse(data);
      console.log(`[Groups] 📂 Loaded ${groupRegistry.length} groups from disk`);
    }
  } catch (error) {
    console.error("[Groups] Error loading groups:", error);
    groupRegistry = [];
  }
}

function saveGroups() {
  try {
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(groupRegistry, null, 2));
    console.log(`[Groups] 💾 Persisted ${groupRegistry.length} groups to disk`);
  } catch (error) {
    console.error("[Groups] Error saving groups:", error);
  }
}

// Initial load
loadGroups();

// ─── User Registry Management Functions ──────────────────────────────────────

/**
 * Register a user and join their private room
 * @param {string} userId - Unique user identifier
 * @param {object} socket - Socket instance
 * @param {object} metadata - User metadata (deviceId, phoneNumber, etc)
 */
function registerUser(userId, socket, metadata = {}) {
  if (!userRegistry[userId]) {
    userRegistry[userId] = {
      userId,
      socketIds: [],
      isOnline: true,
      firstConnectedAt: new Date().toISOString(),
      metadata,
    };
  }

  // Add this socket to the user's list
  if (!userRegistry[userId].socketIds.includes(socket.id)) {
    userRegistry[userId].socketIds.push(socket.id);
  }

  userRegistry[userId].lastSeenAt = new Date().toISOString();
  userRegistry[userId].metadata = {
    ...userRegistry[userId].metadata,
    ...metadata,
  };

  // Join private room named after userId
  socket.join(userId);
  socket.userId = userId;

  console.log(
    `[Register] ✅ User ${userId} registered with socket ${socket.id}`,
  );
  console.log(
    `[Register] 📊 Online users: ${Object.keys(userRegistry).length}`,
  );

  return userRegistry[userId];
}

/**
 * Unregister user socket
 * @param {string} userId - User identifier
 * @param {string} socketId - Socket ID to remove
 */
function unregisterUserSocket(userId, socketId) {
  if (!userRegistry[userId]) return;

  userRegistry[userId].socketIds = userRegistry[userId].socketIds.filter(
    (id) => id !== socketId,
  );

  // If no more sockets for this user, mark as offline
  if (userRegistry[userId].socketIds.length === 0) {
    userRegistry[userId].isOnline = false;
    userRegistry[userId].lastSeenAt = new Date().toISOString();
    console.log(`[Unregister] ✅ User ${userId} is now offline`);
  }
}

/**
 * Get user info
 * @param {string} userId - User identifier
 * @returns {object} User info or null
 */
function getUserInfo(userId) {
  return userRegistry[userId] || null;
}

/**
 * Get all online users (excluding the caller)
 * @param {string} excludeUserId - User ID to exclude from results
 * @returns {Array} Array of online user IDs
 */
function getOnlineUsers(excludeUserId) {
  return Object.values(userRegistry)
    .filter(
      (user) =>
        user.isOnline &&
        user.socketIds.length > 0 &&
        user.userId !== excludeUserId,
    )
    .map((user) => ({
      userId: user.userId,
      isOnline: user.isOnline,
      metadata: user.metadata,
    }));
}

// ─── Phone-Based User Registration ────────────────────────────────────────

/**
 * Register a user by phone number
 * @param {string} phoneNumber - Normalized phone number (+XXXXXXXXXXX)
 * @param {object} socket - Socket instance
 * @param {object} metadata - User metadata
 */
function registerPhoneUser(phoneNumber, socket, metadata = {}) {
  if (!phoneNumber) return null;

  if (!phoneRegistry[phoneNumber]) {
    phoneRegistry[phoneNumber] = {
      phoneNumber,
      socketIds: [],
      isOnline: true,
      firstConnectedAt: new Date().toISOString(),
      metadata,
    };
  }

  if (!phoneRegistry[phoneNumber].socketIds.includes(socket.id)) {
    phoneRegistry[phoneNumber].socketIds.push(socket.id);
  }

  phoneRegistry[phoneNumber].lastSeenAt = new Date().toISOString();
  phoneRegistry[phoneNumber].metadata = {
    ...phoneRegistry[phoneNumber].metadata,
    ...metadata,
  };
  phoneRegistry[phoneNumber].isOnline = true;

  socket.join(phoneNumber);
  socket.phoneNumber = phoneNumber;

  console.log(
    `[PhoneRegister] ✅ Phone ${phoneNumber} registered with socket ${socket.id}`,
  );

  return phoneRegistry[phoneNumber];
}

/**
 * Unregister a phone user socket
 */
function unregisterPhoneUserSocket(phoneNumber, socketId) {
  if (!phoneRegistry[phoneNumber]) return;

  phoneRegistry[phoneNumber].socketIds = phoneRegistry[
    phoneNumber
  ].socketIds.filter((id) => id !== socketId);

  if (phoneRegistry[phoneNumber].socketIds.length === 0) {
    phoneRegistry[phoneNumber].isOnline = false;
    phoneRegistry[phoneNumber].lastSeenAt = new Date().toISOString();
    console.log(`[PhoneUnregister] ✅ Phone ${phoneNumber} is now offline`);
  }
}

/**
 * Get phone user info
 */
function getPhoneUserInfo(phoneNumber) {
  return phoneRegistry[phoneNumber] || null;
}

/**
 * Store offline message
 */
function storeOfflineMessage(recipientPhone, message) {
  if (!offlineMessageQueue.has(recipientPhone)) {
    offlineMessageQueue.set(recipientPhone, []);
  }

  const queue = offlineMessageQueue.get(recipientPhone);
  queue.push(message);

  // Keep only last 100 messages per user
  if (queue.length > 100) {
    queue.shift();
  }

  console.log(
    `[OfflineQueue] Stored message for ${recipientPhone}, queue size: ${queue.length}`,
  );
}

/**
 * Get and clear offline messages for a phone
 */
function getOfflineMessages(phoneNumber) {
  const messages = offlineMessageQueue.get(phoneNumber) || [];
  offlineMessageQueue.delete(phoneNumber);
  console.log(
    `[OfflineQueue] Retrieved ${messages.length} offline messages for ${phoneNumber}`,
  );
  return messages;
}

// ─── HTTP Routes ──────────────────────────────────────────────────────────

/**
 * Health check endpoint
 * Returns online users and server status
 */
app.get("/health", (req, res) => {
  const onlineUsersList = getOnlineUsers();

  res.json({
    status: "running",
    timestamp: new Date().toISOString(),
    server: {
      port: PORT,
      protocol: "websocket",
    },
    onlineUsersCount: onlineUsersList.length,
    onlineUsers: onlineUsersList,
  });
});

/**
 * Test connectivity endpoint
 */
app.get("/test", (req, res) => {
  res.json({ ok: true, message: "Server is reachable" });
});

/**
 * Get specific user status
 */
app.get("/user/:userId", (req, res) => {
  const { userId } = req.params;
  const userInfo = getUserInfo(userId);

  if (!userInfo) {
    return res.status(404).json({
      error: "User not found",
      userId,
    });
  }

  res.json({
    userId,
    isOnline: userInfo.isOnline,
    metadata: userInfo.metadata,
    lastSeenAt: userInfo.lastSeenAt,
    firstConnectedAt: userInfo.firstConnectedAt,
  });
});

// ─── Upload Route ───────────────────────────────────────────────────────

/**
 * Handle direct file uploads for large media
 */
app.post("/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Return path-only URL so receiver can use their own server base (fixes "receiver can't open")
    // Client will prepend connectionManager.getServerUrl() when downloading/playing
    const pathOnlyUrl = `/uploads/${req.file.filename}`;

    console.log(`[Upload] ✅ File received: ${req.file.filename}, Size: ${(req.file.size / (1024 * 1024)).toFixed(2)}MB`);

    res.json({
      success: true,
      filename: req.file.filename,
      url: pathOnlyUrl,
      mimetype: req.file.mimetype,
      size: req.file.size
    });
  } catch (error) {
    console.error("[Upload] Error:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ─── Socket.IO Events ─────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[Socket] New connection: ${socket.id}`);

  /**
   * PHONE-BASED REGISTRATION EVENT
   * Registers user by phone number and delivers offline messages
   * Event: client.emit("register", { phoneNumber })
   */
  socket.on("register", (data, callback) => {
    try {
      const { phoneNumber } = data;

      if (!phoneNumber) {
        console.log(`[Register] ❌ No phoneNumber provided`);
        callback({ success: false, error: "phoneNumber is required" });
        return;
      }

      // Register user by phone
      const phoneInfo = registerPhoneUser(phoneNumber, socket, {});

      console.log(
        `[Register] ✅ ${phoneNumber} registered, socket: ${socket.id}`,
      );

      // Get any offline messages waiting for this user
      const offlineMessages = getOfflineMessages(phoneNumber);

      // Discovery: Find all groups this user belongs to
      const userGroups = groupRegistry.filter(group =>
        group.members.some(member => member.phoneNumber === phoneNumber)
      );

      // Notify all clients about this user coming online
      io.emit("user_online_phone", {
        phoneNumber,
        timestamp: new Date().toISOString(),
      });

      callback({
        success: true,
        phoneNumber,
        socketId: socket.id,
        offlineMessagesCount: offlineMessages.length,
        groups: userGroups, // Return groups for automatic discovery
      });

      // Send offline messages immediately after registration
      if (offlineMessages.length > 0) {
        console.log(
          `[Register] 📬 Delivering ${offlineMessages.length} offline messages to ${phoneNumber}`,
        );
        socket.emit("offline_messages", {
          count: offlineMessages.length,
          messages: offlineMessages,
          deliveredAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error(`[Register] Error:`, error);
      callback({ success: false, error: error.message });
    }
  });

  /**
   * USER JOIN EVENT
   * Registers user and joins private room
   * Event: client.emit("user_join", { userId, metadata })
   */
  socket.on("user_join", (data, callback) => {
    try {
      const { userId, metadata } = data;

      if (!userId) {
        console.log(`[UserJoin] ❌ No userId provided`);
        callback({ success: false, error: "userId is required" });
        return;
      }

      // Register user in memory
      const userInfo = registerUser(userId, socket, metadata);

      console.log(`[UserJoin] ✅ ${userId} joined, socket: ${socket.id}`);

      // Notify all clients about this user coming online
      io.emit("user_online", {
        userId,
        timestamp: new Date().toISOString(),
        metadata,
      });

      callback({
        success: true,
        userId,
        socketId: socket.id,
        onlineUsers: getOnlineUsers(userId),
      });
    } catch (error) {
      console.error(`[UserJoin] Error:`, error);
      callback({ success: false, error: error.message });
    }
  });

  /**
   * SEND MESSAGE EVENT (PHONE-BASED)
   * Sends message to a phone number with offline storage
   * Event: client.emit("send_message", {
   *   id, from (sender phone), to (recipient phone), text, images[], timestamp
   * })
   */
  socket.on("send_message", (data, callback) => {
    try {
      const { id, from, to, text, images, timestamp, isViewOnce } = data;

      // Validate input
      if (!from || !to || (!text && (!images || images.length === 0)) || !id) {
        callback({
          success: false,
          error: "Missing required fields: id, from, to, (text or images)",
        });
        return;
      }

      // Build message object with sender phone number
      const message = {
        id,
        from, // Sender's phone number
        to, // Recipient's phone number
        text: text ? text.trim() : "",
        images: images || [],
        isViewOnce: isViewOnce || false,
        timestamp: timestamp || new Date().toISOString(),
        deliveryStatus: "sending",
      };

      console.log(
        `[SendMessage] From: ${from} → To: ${to}, messageId: ${id}, images: ${images?.length || 0}`,
      );

      // Check if recipient is online
      const recipientInfo = getPhoneUserInfo(to);
      let delivered = false;

      if (
        recipientInfo &&
        recipientInfo.isOnline &&
        recipientInfo.socketIds.length > 0
      ) {
        // Recipient online - deliver immediately
        io.to(to).emit("receive_message", message);
        delivered = true;
        console.log(`[SendMessage] ✅ Delivered to ${to} (online)`);
      } else {
        // Recipient offline - store in queue
        storeOfflineMessage(to, message);
        console.log(`[SendMessage] 💾 Stored offline message for ${to}`);
      }

      callback({
        success: true,
        messageId: id,
        delivered,
        deliveryStatus: delivered ? "sent" : "stored",
      });
    } catch (error) {
      console.error(`[SendMessage] Error:`, error);
      callback({ success: false, error: error.message });
    }
  });

  /**
   * DELETE MESSAGE EVENT
   */
  socket.on("delete_message", (data, callback) => {
    try {
      const { messageId, to } = data;
      if (!messageId || !to) {
        if (callback) callback({ success: false, error: "Missing required fields: messageId, to" });
        return;
      }

      console.log(`[DeleteMessage] Deleting messageId: ${messageId} for to: ${to}`);

      // Forward deletion event if recipient is online
      const recipientInfo = getPhoneUserInfo(to);
      if (recipientInfo && recipientInfo.isOnline && recipientInfo.socketIds.length > 0) {
        io.to(to).emit("message_deleted", { messageId });
        console.log(`[DeleteMessage] ✅ Delivered delete event to ${to} (online)`);
      } else {
        console.log(`[DeleteMessage] ⏳ ${to} offline, deletion won't be synced yet`);
      }

      if (callback) callback({ success: true, messageId });
    } catch (error) {
      console.error(`[DeleteMessage] Error:`, error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * EDIT MESSAGE EVENT
   */
  socket.on("edit_message", (data, callback) => {
    try {
      const { messageId, to, newText } = data;
      if (!messageId || !to || newText === undefined) {
        if (callback) callback({ success: false, error: "Missing required fields" });
        return;
      }

      console.log(`[EditMessage] Editing messageId: ${messageId} for to: ${to}`);

      // Forward edit event if recipient is online
      const recipientInfo = getPhoneUserInfo(to);
      if (recipientInfo && recipientInfo.isOnline && recipientInfo.socketIds.length > 0) {
        io.to(to).emit("message_edited", { messageId, newText });
        console.log(`[EditMessage] ✅ Delivered edit event to ${to} (online)`);
      } else {
        console.log(`[EditMessage] ⏳ ${to} offline, edit won't be synced yet`);
      }

      if (callback) callback({ success: true, messageId });
    } catch (error) {
      console.error(`[EditMessage] Error:`, error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * CREATE GROUP EVENT
   * Broadcasts the new group data to all members
   */
  socket.on("create_group", (data, callback) => {
    try {
      const { group } = data;
      if (!group || !group.members || group.members.length === 0) {
        if (callback) callback({ success: false, error: "Missing required group fields" });
        return;
      }

      // Enforce 5 member limit (including creator)
      if (group.members.length > 5) {
        console.log(`[CreateGroup] ❌ Rejected group ${group.name}: Too many members (${group.members.length})`);
        if (callback) callback({ success: false, error: "Group member limit is 5 persons" });
        return;
      }

      console.log(`[CreateGroup] Broadcasting new group: ${group.name} to ${group.members.length} members`);

      // Add status to members if not present
      group.members = group.members.map(member => ({
        ...member,
        status: member.phoneNumber === group.createdBy ? 'accepted' : (member.status || 'pending')
      }));

      // Persist group on server
      const existingIndex = groupRegistry.findIndex(g => g.id === group.id);
      if (existingIndex >= 0) {
        groupRegistry[existingIndex] = group;
      } else {
        groupRegistry.push(group);
      }
      saveGroups();

      group.members.forEach((member) => {
        const memberPhone = member.phoneNumber;
        // Don't send back to the creator
        if (memberPhone === group.createdBy) return;

        const recipientInfo = getPhoneUserInfo(memberPhone);
        if (recipientInfo && recipientInfo.isOnline && recipientInfo.socketIds.length > 0) {
          io.to(memberPhone).emit("group_added", { group });
          console.log(`[CreateGroup] ✅ Delivered to ${memberPhone} (online)`);
        } else {
          // Store offline event if needed
          storeOfflineMessage(memberPhone, {
            type: 'group_added',
            group
          });
          console.log(`[CreateGroup] ⏳ ${memberPhone} offline. Will sync when they open the app and pull groups.`);
        }
      });

      if (callback) callback({ success: true, groupId: group.id });
    } catch (error) {
      console.error(`[CreateGroup] Error:`, error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * SEND GROUP MESSAGE EVENT
   * Forwards message to all group members
   */
  socket.on("send_group_message", (data, callback) => {
    try {
      const { message, members } = data;
      if (!message || !members || !Array.isArray(members)) {
        if (callback) callback({ success: false, error: "Missing message or members array" });
        return;
      }

      console.log(`[GroupMessage] From ${message.from} in group ${message.groupId} to ${members.length} members`);

      members.forEach((member) => {
        const memberPhone = member.phoneNumber;
        // Don't send back to the sender
        if (memberPhone === message.from) return;

        const recipientInfo = getPhoneUserInfo(memberPhone);
        if (recipientInfo && recipientInfo.isOnline && recipientInfo.socketIds.length > 0) {
          io.to(memberPhone).emit("group_message", { message });
          console.log(`[GroupMessage] ✅ Delivered to ${memberPhone} (online)`);
        } else {
          // Store as offline message for this phone number
          storeOfflineMessage(memberPhone, {
            ...message,
            to: memberPhone, // Ensure it gets queued correctly
            isGroupMessage: true
          });
          console.log(`[GroupMessage] 💾 Stored offline message for ${memberPhone}`);
        }
      });

      if (callback) callback({ success: true, messageId: message.id });
    } catch (error) {
      console.error(`[GroupMessage] Error:`, error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * DELETE GROUP MESSAGE EVENT
   * Forwards deletion to all group members
   */
  socket.on("delete_group_message", (data, callback) => {
    try {
      const { groupId, messageId } = data;
      if (!groupId || !messageId) {
        if (callback) callback({ success: false, error: "Missing groupId or messageId" });
        return;
      }

      console.log(`[DeleteGroupMessage] Deleting messageId: ${messageId} in group ${groupId}`);

      // Find group to get members
      const group = groupRegistry.find(g => g.id === groupId);
      if (!group) {
        if (callback) callback({ success: false, error: "Group not found on server" });
        return;
      }

      group.members.forEach((member) => {
        const memberPhone = member.phoneNumber;

        const recipientInfo = getPhoneUserInfo(memberPhone);
        if (recipientInfo && recipientInfo.isOnline && recipientInfo.socketIds.length > 0) {
          // Emit a group-specific delete event
          io.to(memberPhone).emit("group_message_deleted", { groupId, messageId });
          console.log(`[DeleteGroupMessage] ✅ Delivered to ${memberPhone} (online)`);
        } else {
          // Store offline delete event (not strictly necessary if messages sync on pull, but good for real-time consistency)
          storeOfflineMessage(memberPhone, {
            type: 'group_message_deleted',
            groupId,
            messageId,
            isSystemEvent: true
          });
          console.log(`[DeleteGroupMessage] 💾 Stored offline delete event for ${memberPhone}`);
        }
      });

      if (callback) callback({ success: true, messageId });
    } catch (error) {
      console.error(`[DeleteGroupMessage] Error:`, error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * UPDATE GROUP MEMBERS EVENT
   * Broadcasts updated group to all current members
   */
  socket.on("update_group_members", (data, callback) => {
    try {
      const { group } = data;
      if (!group || !group.members) {
        if (callback) callback({ success: false, error: "Missing required group fields" });
        return;
      }

      // Verify group exists and get its index
      const existingIndex = groupRegistry.findIndex(g => g.id === group.id);

      if (existingIndex === -1) {
        console.log(`[UpdateGroup] ❌ Group ${group.id} not found on server`);
        if (callback) callback({ success: false, error: "Group not found" });
        return;
      }

      const oldGroup = groupRegistry[existingIndex];

      // Verification: only admin can update group
      // Use socket.phoneNumber for secure verification
      if (oldGroup.adminPhone !== socket.phoneNumber) {
        console.log(`[UpdateGroup] ❌ Unauthorized update attempt by ${socket.phoneNumber} (Admin is ${oldGroup.adminPhone})`);
        if (callback) callback({ success: false, error: "Only admin can update group" });
        return;
      }

      console.log(`[UpdateGroup] Broadcasting updated group: ${group.name}`);

      // Detect removed members and notify them
      const oldMembers = oldGroup.members || [];
      const newMembers = group.members || [];
      
      const removedMembers = oldMembers.filter(oldM => 
        !newMembers.some(newM => newM.phoneNumber === oldM.phoneNumber)
      );

      removedMembers.forEach(member => {
        const memberPhone = member.phoneNumber;
        const recipientInfo = getPhoneUserInfo(memberPhone);
        if (recipientInfo && recipientInfo.isOnline && recipientInfo.socketIds.length > 0) {
          io.to(memberPhone).emit("group_deleted", { groupId: group.id });
          console.log(`[UpdateGroup] 🗑️ Notified removed member ${memberPhone} (online)`);
        } else {
          storeOfflineMessage(memberPhone, {
            type: 'group_deleted',
            groupId: group.id
          });
          console.log(`[UpdateGroup] 💾 Queued deletion for removed member ${memberPhone} (offline)`);
        }
      });

      groupRegistry[existingIndex] = group;
      saveGroups();

      group.members.forEach((member) => {
        const memberPhone = member.phoneNumber;

        const recipientInfo = getPhoneUserInfo(memberPhone);
        if (recipientInfo && recipientInfo.isOnline && recipientInfo.socketIds.length > 0) {
          io.to(memberPhone).emit("group_updated", { group });
          console.log(`[UpdateGroup] ✅ Delivered update to ${memberPhone} (online)`);
        } else {
          storeOfflineMessage(memberPhone, {
            type: 'group_updated',
            group
          });
          console.log(`[UpdateGroup] ⏳ ${memberPhone} offline. Will sync when they open the app.`);
        }
      });

      if (callback) callback({ success: true, groupId: group.id });
    } catch (error) {
      console.error(`[UpdateGroup] Error:`, error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * LEAVE GROUP EVENT
   * Removes member from group and notifies others
   */
  socket.on("leave_group", (data, callback) => {
    try {
      const { groupId, phoneNumber } = data;
      if (!groupId || !phoneNumber) {
        if (callback) callback({ success: false, error: "Missing groupId or phoneNumber" });
        return;
      }

      console.log(`[LeaveGroup] User ${phoneNumber} leaving group ${groupId}`);

      const groupIndex = groupRegistry.findIndex(g => g.id === groupId);
      if (groupIndex === -1) {
        if (callback) callback({ success: false, error: "Group not found" });
        return;
      }

      const group = groupRegistry[groupIndex];
      const updatedMembers = group.members.filter(m => m.phoneNumber !== phoneNumber);

      // If last member leaves, we could delete the group, but let's just update for now
      group.members = updatedMembers;
      saveGroups();

      // Notify other members
      group.members.forEach((member) => {
        const memberPhone = member.phoneNumber;
        const recipientInfo = getPhoneUserInfo(memberPhone);
        if (recipientInfo && recipientInfo.isOnline && recipientInfo.socketIds.length > 0) {
          io.to(memberPhone).emit("group_updated", { group });
        } else {
          storeOfflineMessage(memberPhone, { type: 'group_updated', group });
        }
      });

      // Notify the leaving user immediately so their UI removes the group
      const leaverInfo = getPhoneUserInfo(phoneNumber);
      if (leaverInfo && leaverInfo.isOnline && leaverInfo.socketIds.length > 0) {
        io.to(phoneNumber).emit("group_deleted", { groupId });
        console.log(`[LeaveGroup] 🗑️ Notified leaver ${phoneNumber} (online)`);
      } else {
        storeOfflineMessage(phoneNumber, { type: 'group_deleted', groupId });
        console.log(`[LeaveGroup] 💾 Queued deletion for leaver ${phoneNumber} (offline)`);
      }

      if (callback) callback({ success: true });
    } catch (error) {
      console.error(`[LeaveGroup] Error:`, error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * DELETE GROUP EVENT
   * Permanently deletes group and notifies all members
   */
  socket.on("delete_group", (data, callback) => {
    try {
      const { groupId, adminPhone } = data;
      if (!groupId) {
        if (callback) callback({ success: false, error: "Missing groupId" });
        return;
      }

      console.log(`[DeleteGroup] Deleting group ${groupId}`);

      const groupIndex = groupRegistry.findIndex(g => g.id === groupId);
      if (groupIndex === -1) {
        if (callback) callback({ success: false, error: "Group not found" });
        return;
      }

      const group = groupRegistry[groupIndex];
      
      // Verification: only admin can delete
      if (group.adminPhone !== socket.phoneNumber) {
        console.log(`[DeleteGroup] ❌ Unauthorized delete attempt by ${socket.phoneNumber} (Admin is ${group.adminPhone})`);
        if (callback) callback({ success: false, error: "Only admin can delete group" });
        return;
      }

      // Keep a copy of members to notify them
      const membersToNotify = [...group.members];

      // Remove from registry
      groupRegistry.splice(groupIndex, 1);
      saveGroups();

      // Notify all members
      membersToNotify.forEach((member) => {
        const memberPhone = member.phoneNumber;
        const recipientInfo = getPhoneUserInfo(memberPhone);
        if (recipientInfo && recipientInfo.isOnline && recipientInfo.socketIds.length > 0) {
          io.to(memberPhone).emit("group_deleted", { groupId });
        } else {
          storeOfflineMessage(memberPhone, { type: 'group_deleted', groupId });
        }
      });

      if (callback) callback({ success: true });
    } catch (error) {
      console.error(`[DeleteGroup] Error:`, error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * SEND MESSAGE EVENT (OLD - USER ID BASED)
   * Kept for backward compatibility
   */
  socket.on("send_message_userId", (data, callback) => {
    try {
      const senderId = socket.userId;
      const { messageId, receiverId, text, timestamp, conversationId } = data;

      // Validate input
      if (!senderId) {
        callback({ success: false, error: "User not registered" });
        return;
      }

      if (!messageId || !receiverId || !text) {
        callback({ success: false, error: "Missing required fields" });
        return;
      }

      // Build message object
      const message = {
        id: messageId,
        senderId,
        receiverId,
        conversationId: conversationId || `${senderId}_${receiverId}`,
        text: text.trim(),
        timestamp: timestamp || new Date().toISOString(),
        deliveryStatus: "sending",
      };

      console.log(
        `[SendMessage] From: ${senderId} → To: ${receiverId}, messageId: ${messageId}`,
      );

      // Check if receiver is online
      const receiverInfo = getUserInfo(receiverId);
      let delivered = false;

      if (
        receiverInfo &&
        receiverInfo.isOnline &&
        receiverInfo.socketIds.length > 0
      ) {
        // Receiver online - deliver to their room
        io.to(receiverId).emit("receive_message", message);
        delivered = true;
        console.log(`[SendMessage] ✅ Delivered to ${receiverId} (online)`);
      } else {
        // Receiver offline - client will retry
        console.log(
          `[SendMessage] ⏳ ${receiverId} offline, client will retry`,
        );
      }

      callback({
        success: true,
        messageId,
        delivered,
        deliveryStatus: delivered ? "sent" : "pending",
      });
    } catch (error) {
      console.error(`[SendMessage] Error:`, error);
      callback({ success: false, error: error.message });
    }
  });

  /**
   * MESSAGE ACKNOWLEDGEMENT EVENT
   * Receiver confirms message reception
   * Event: client.emit("message_ack", { messageId, receiverId, acknowledgedAt })
   */
  socket.on("message_ack", (data, callback) => {
    try {
      const { messageId, senderId, acknowledgedAt } = data;

      if (!messageId || !senderId) {
        callback({ success: false, error: "Missing messageId or senderId" });
        return;
      }

      // Track acknowledgement
      messageAcknowledgements.set(messageId, {
        acknowledgedAt: acknowledgedAt || new Date().toISOString(),
        receiverId: socket.userId,
      });

      // Send acknowledgement back to sender
      io.to(senderId).emit("message_acked", {
        messageId,
        receiverId: socket.userId,
        acknowledgedAt: acknowledgedAt || new Date().toISOString(),
      });

      console.log(`[MessageAck] Message ${messageId} acknowledged`);

      callback({ success: true });
    } catch (error) {
      console.error(`[MessageAck] Error:`, error);
      callback({ success: false, error: error.message });
    }
  });

  /**
   * TYPING INDICATOR EVENT
   * Notify receiver that sender is typing
   */
  socket.on("typing", (data, callback) => {
    try {
      const senderId = socket.userId;
      const { receiverId, conversationId, isTyping } = data;

      if (!receiverId) {
        callback({ success: false, error: "receiverId required" });
        return;
      }

      // Send to receiver only
      io.to(receiverId).emit("user_typing", {
        senderId,
        conversationId,
        isTyping: !!isTyping,
        timestamp: new Date().toISOString(),
      });

      callback({ success: true });
    } catch (error) {
      console.error(`[Typing] Error:`, error);
      callback({ success: false, error: error.message });
    }
  });

  /**
   * REQUEST ONLINE USERS
   * Request list of currently online users
   */
  socket.on("request_online_users", (data, callback) => {
    try {
      const currentUserId = socket.userId;
      const onlineUsers = getOnlineUsers(currentUserId);

      callback({
        success: true,
        onlineUsers,
      });
    } catch (error) {
      console.error(`[RequestOnlineUsers] Error:`, error);
      callback({ success: false, error: error.message });
    }
  });

  /**
   * VIEW-ONCE MESSAGE SEEN EVENT
   * Receiver notifies server that a view-once message was opened.
   * Server relays to sender so both sides can show encrypted state.
   * Event: client.emit("view_once_seen", { senderPhone, messageId })
   */
  socket.on("view_once_seen", (data, callback) => {
    try {
      const { senderPhone, messageId } = data;
      if (!senderPhone || !messageId) {
        if (callback) callback({ success: false, error: "Missing senderPhone or messageId" });
        return;
      }

      console.log(`[ViewOnceSeen] Message ${messageId} opened, notifying sender ${senderPhone}`);

      const senderInfo = getPhoneUserInfo(senderPhone);
      if (senderInfo && senderInfo.isOnline && senderInfo.socketIds.length > 0) {
        io.to(senderPhone).emit("view_once_opened", { messageId });
        console.log(`[ViewOnceSeen] ✅ Notified sender ${senderPhone} (online)`);
      } else {
        // Queue for offline delivery so sender learns about it on reconnect
        storeOfflineMessage(senderPhone, {
          type: "view_once_opened",
          messageId,
          isSystemEvent: true,
        });
        console.log(`[ViewOnceSeen] 💾 Sender ${senderPhone} offline, queued notification`);
      }

      if (callback) callback({ success: true, messageId });
    } catch (error) {
      console.error(`[ViewOnceSeen] Error:`, error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * REACT TO MESSAGE EVENT
   * User sends an emoji reaction on a message, server relays to recipient.
   * Event: client.emit("react_message", { to, messageId, emoji, reactorPhone })
   */
  socket.on("react_message", (data, callback) => {
    try {
      const { to, messageId, emoji, reactorPhone } = data;
      if (!to || !messageId || !emoji || !reactorPhone) {
        if (callback) callback({ success: false, error: "Missing required fields: to, messageId, emoji, reactorPhone" });
        return;
      }

      console.log(`[ReactMessage] ${reactorPhone} reacted ${emoji} on ${messageId} → ${to}`);

      const recipientInfo = getPhoneUserInfo(to);
      if (recipientInfo && recipientInfo.isOnline && recipientInfo.socketIds.length > 0) {
        io.to(to).emit("message_reacted", { messageId, emoji, reactorPhone });
        console.log(`[ReactMessage] ✅ Delivered reaction to ${to} (online)`);
      } else {
        storeOfflineMessage(to, {
          type: "message_reacted",
          messageId,
          emoji,
          reactorPhone,
          isSystemEvent: true,
        });
        console.log(`[ReactMessage] 💾 ${to} offline, queued reaction`);
      }

      if (callback) callback({ success: true, messageId });
    } catch (error) {
      console.error(`[ReactMessage] Error:`, error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * DELETE MESSAGE EVENT
   * Supports both "delete for me" (no relay) and "delete for everyone" (relay to other party).
   * Event: client.emit("delete_message", { to, messageId, deleteForEveryone })
   */
  socket.on("delete_message", (data, callback) => {
    try {
      const { to, messageId, deleteForEveryone } = data;
      if (!to || !messageId) {
        if (callback) callback({ success: false, error: "Missing required fields: to, messageId" });
        return;
      }

      console.log(`[DeleteMessage] messageId: ${messageId}, to: ${to}, forEveryone: ${deleteForEveryone}`);

      if (deleteForEveryone) {
        const recipientInfo = getPhoneUserInfo(to);
        if (recipientInfo && recipientInfo.isOnline && recipientInfo.socketIds.length > 0) {
          io.to(to).emit("message_deleted", { messageId });
          console.log(`[DeleteMessage] ✅ Delete relayed to ${to} (online)`);
        } else {
          storeOfflineMessage(to, {
            type: "message_deleted",
            messageId,
            isSystemEvent: true,
          });
          console.log(`[DeleteMessage] 💾 ${to} offline, queued delete`);
        }
      }

      if (callback) callback({ success: true, messageId });
    } catch (error) {
      console.error(`[DeleteMessage] Error:`, error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * HANDLE DISCONNECT
   */
  socket.on("disconnect", (reason) => {
    try {
      const userId = socket.userId;
      const phoneNumber = socket.phoneNumber;

      // Handle userId-based user disconnect
      if (userId) {
        unregisterUserSocket(userId, socket.id);
        const userInfo = getUserInfo(userId);

        if (userInfo && !userInfo.isOnline) {
          // User is now offline - notify others
          io.emit("user_offline", {
            userId,
            timestamp: new Date().toISOString(),
          });

          console.log(`[Disconnect] ✅ User ${userId} is offline`);
        } else {
          console.log(
            `[Disconnect] User ${userId} still has other connections`,
          );
        }
      }

      // Handle phone-based user disconnect
      if (phoneNumber) {
        unregisterPhoneUserSocket(phoneNumber, socket.id);
        const phoneInfo = getPhoneUserInfo(phoneNumber);

        if (phoneInfo && !phoneInfo.isOnline) {
          // User is now offline - notify others
          io.emit("user_offline_phone", {
            phoneNumber,
            timestamp: new Date().toISOString(),
          });

          console.log(`[Disconnect] ✅ Phone ${phoneNumber} is offline`);
        } else {
          console.log(
            `[Disconnect] Phone ${phoneNumber} still has other connections`,
          );
        }
      }
    } catch (error) {
      console.error(`[Disconnect] Error:`, error);
    }
  });

  /**
   * HANDLE CONNECTION ERRORS
   */
  socket.on("error", (error) => {
    console.error(`[Socket Error] ${socket.id}:`, error);
  });
});

// ─── Start Server ──────────────────────────────────────────────────────

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  Real-Time One-to-One Chat Server (Locksy)            ║");
  console.log("║  Scalable Device Private Messaging              ║");
  console.log("║  WebSocket Protocol | No Server-Side Message Storage  ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📍 WebSocket: ws://0.0.0.0:${PORT}`);
  console.log(`📍 HTTP:      http://0.0.0.0:${PORT}\n`);
  console.log("Socket.IO Events:");
  console.log("  • user_join - Register user and join private room");
  console.log("  • send_message - Send private message");
  console.log("  • message_ack - Acknowledge message reception");
  console.log("  • typing - Notify typing status");
  console.log("  • request_online_users - Get online users\n");
  console.log("HTTP Endpoints:");
  console.log("  GET /health       - Server status & online users");
  console.log("  GET /test         - Connectivity check");
  console.log("  GET /user/:userId - Get specific user status\n");
});

process.on("SIGTERM", () => {
  console.log("\n[Server] SIGTERM received, shutting down...");
  httpServer.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("\n[Server] SIGINT received, shutting down...");
  httpServer.close(() => process.exit(0));
});

export default io;
