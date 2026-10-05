import type { DeviceActions } from '../../../../packages/core/src/devices/service.js';
import {
  AddSimulatedDevice,
  UpdateDevice,
  DeviceControlInput,
  RequestDeviceCommand,
  DecideDeviceCommand,
  CancelDeviceCommand,
  ResolveDeviceCommand,
} from '../../../../packages/contracts/src/devices.js';
import { type ApiServer, key, params } from './shared.js';
export function registerDeviceRoutes(server: ApiServer, devices: DeviceActions) {
  server.get('/devices', () => devices.list());
  server.post('/devices/simulated', { schema: { body: AddSimulatedDevice } }, (r) =>
    devices.addSimulation(key(r), r.body),
  );
  server.patch('/devices/:id', { schema: { params, body: UpdateDevice } }, (r) =>
    devices.update(key(r), r.params.id, r.body),
  );
  server.patch('/device-control', { schema: { body: DeviceControlInput } }, (r) => devices.control(key(r), r.body));
  server.get('/device-commands', () => devices.history());
  server.get('/device-commands/:id', { schema: { params } }, (r) => devices.getCommand(r.params.id));
  server.post('/devices/:id/commands', { schema: { params, body: RequestDeviceCommand } }, (r) =>
    devices.request(key(r), r.params.id, r.body),
  );
  server.post('/device-commands/:id/decision', { schema: { params, body: DecideDeviceCommand } }, (r) =>
    devices.decide(key(r), r.params.id, r.body),
  );
  server.post('/device-commands/:id/cancel', { schema: { params, body: CancelDeviceCommand } }, (r) =>
    devices.cancel(key(r), r.params.id, r.body),
  );
  server.post('/device-commands/:id/resolve', { schema: { params, body: ResolveDeviceCommand } }, (r) =>
    devices.resolve(key(r), r.params.id, r.body),
  );
}
