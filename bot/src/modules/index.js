import admin from './admin.js';
import antiraid from './antiraid.js';
import applications from './applications.js';
import automod from './automod.js';
import gamelogs from './gamelogs.js';
import moderation from './moderation.js';
import panels from './panels.js';
import roles from './roles.js';
import status from './status.js';
import steam from './steam.js';
import tickets from './tickets.js';
import verify from './verify.js';

export const MODULES = [status, admin, gamelogs, steam, applications, tickets, roles, verify, panels, moderation, automod, antiraid];
