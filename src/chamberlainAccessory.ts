import type {
  Logger,
  Service,
  PlatformAccessory,
  CharacteristicValue,
} from 'homebridge';

import { CharacteristicEventTypes } from 'homebridge';

import ChamberlainService from './chamberlainService';
import { ChamberlainHomebridgePlatform } from './platform';
import callbackify from './util/callbackify';

/**
 * Chamberlain Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class ChamberlainAccessory {
  private readonly log: Logger;

  private service: Service;
  private chamberlainService = ChamberlainService.getInstance();

  private targetDoorState: CharacteristicValue;
  private currentDoorState: CharacteristicValue;

  private pollTimeoutId!: NodeJS.Timeout;
  private deviceId: string;

  private configPoll = {
    activeDelay : 2000,
    idleDelay: 30000,
    tries: 0,
    maxTries: 15,
  }

  constructor(
    private readonly platform: ChamberlainHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.log = this.platform.log;
    const { username, password, deviceId, myqUserAgent, activeDelay, idleDelay, debug } = accessory.context.device;
    this.deviceId = deviceId;

    this.log.debug(accessory.context.device);

    const garageDoorOpener = this.platform.Service.GarageDoorOpener;

    this.chamberlainService.init(username, password, deviceId, myqUserAgent, this.log, debug);
    if(idleDelay){
      this.configPoll.idleDelay = idleDelay;
    }

    if(activeDelay){
      this.configPoll.activeDelay = activeDelay;
    }

    //make sure the maxTries covers at least 30 seconds
    if((this.configPoll.activeDelay * this.configPoll.maxTries) < 30000){
      this.configPoll.maxTries = this.configPoll.activeDelay / 30000;
      this.log.debug(`Setting this.configPoll.maxTries to: ${this.configPoll.maxTries}`);
    }

    // get the GarageDoorOpener service if it exists, otherwise create a new GarageDoorOpener service
    this.service =
      this.accessory.getService(garageDoorOpener) ||
      this.accessory.addService(garageDoorOpener);

    // set the service name, this is what is displayed as the default name on the Home app
    // we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.name,
    );

    // CurrentDoorState
    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentDoorState)
      .on(CharacteristicEventTypes.GET, callbackify(this.getCurrentDoorState))
      .on('change', ({ newValue }) => {
        this.log.debug(`Garage Door state changed to ${newValue}`);
      });

    // TargetDoorState
    this.service
      .getCharacteristic(this.platform.Characteristic.TargetDoorState)
      .on(CharacteristicEventTypes.SET, callbackify(this.setTargetDoorState))
      .on(CharacteristicEventTypes.GET, callbackify(this.getTargetDoorState))
      .on('change', ({ newValue }) => {
        this.log.debug(`Garage Door targetstate changed to ${newValue}`);
      });

    // Set the class variables to default
    this.targetDoorState = this.platform.Characteristic.TargetDoorState.CLOSED;
    this.currentDoorState = this.platform.Characteristic.CurrentDoorState.CLOSED;

    // Udpate the characteristic for target and current
    this.service.updateCharacteristic(
      this.platform.Characteristic.TargetDoorState,
      this.targetDoorState,
    );
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentDoorState,
      this.currentDoorState,
    );

    // IIFE to 'watch' for changes
    (this.poll = this.poll.bind(this))();
  }

  // poll every X seconds for door state changes
  // during a state change the poll will happen more frequently until the state is set back to matching values
  poll = async () => {
    if(!this.deviceId || this.deviceId === ''){
      // this is a new/unknown device so dont poll it
      return;
    }

    // remove the old poll
    clearTimeout(this.pollTimeoutId);

    // get (and set) the current door state
    await this.getCurrentDoorState();

    let delay;
    if(this.targetDoorState !== this.currentDoorState){
      delay = this.configPoll.activeDelay;
      this.configPoll.tries+=1;
      this.log.debug(`currentDoorState ${this.currentDoorState} does not match targetDoorState ${this.targetDoorState} this.configPoll.tries: ${this.configPoll.tries}`);
    } else {
      delay = this.configPoll.idleDelay;
      this.configPoll.tries = 0;
      this.log.debug(`currentDoorState ${this.currentDoorState} matches targetDoorState ${this.targetDoorState} this.configPoll.tries:${this.configPoll.tries}`);
    }

    if(this.configPoll.tries >= this.configPoll.maxTries){
      this.log.debug(`this.configPoll.maxTries exceeded: ${this.configPoll.maxTries} - asking to setTargetDoorState ${this.currentDoorState}`);
      this.setTargetDoorState(this.currentDoorState);
      this.configPoll.tries = 0;
    }

    this.log.debug(
      `POLL currentDoorState ${this.currentDoorState} targetDoorState ${this.targetDoorState} (Delay ${delay})`,
    );

    // set up a new poll
    this.pollTimeoutId = setTimeout(this.poll, delay);
  };

  // tell the chamberlain service the new target state
  // update that in the class variable
  // set the targetState characteristic with the desired value
  setTargetDoorState = async (targetState: CharacteristicValue) => {
    if (targetState === this.platform.Characteristic.TargetDoorState.CLOSED) {
      // CLOSE
      this.log.debug('Closing the Garage!');
      try {
        this.targetDoorState = this.platform.Characteristic.TargetDoorState.CLOSED;
        const result = await this.chamberlainService.closeDoor();
        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetDoorState,
          targetState,
        );
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentDoorState,
          this.platform.Characteristic.CurrentDoorState.CLOSING,
        );

        this.log.debug('Closing the Garage result: ', result);
      } catch (error) {
        this.log.debug('Error closing garage: ', error);
      }
    } else if (
      targetState === this.platform.Characteristic.TargetDoorState.OPEN
    ) {
      // OPEN
      this.log.debug('Opening the Garage!');
      try {
        const result = await this.chamberlainService.openDoor();

        this.targetDoorState = this.platform.Characteristic.TargetDoorState.OPEN;
        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetDoorState,
          targetState,
        );
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentDoorState,
          this.platform.Characteristic.CurrentDoorState.OPENING,
        );

        this.log.debug('Opening the Garage: ', result);
      } catch (error) {
        this.log.debug('Error opening garage: ', error);
      }
    }
  };

  // return the target door state
  getTargetDoorState = async () => {
    return this.targetDoorState;
  };

  // ask the chamberlain service for the current door state
  // set the currentDoorState class variable and characteristic with the result
  getCurrentDoorState = async () => {
    this.log.debug('Status of the Garage!');
    let state = 'closed';
    try {
      state = await this.chamberlainService.getDoorState();

      this.log.debug('Status of the Garage result: ', state);

      this.currentDoorState = this.mapCurrentDoorState(state);

      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentDoorState,
        this.currentDoorState,
      );

      this.log.debug('getDoorState of the Garage : ', this.currentDoorState);

      return this.currentDoorState;
    } catch (error) {
      this.log.debug('Error checking status: ', error);
    }
  };

  // map the value from the chamberlain API to a homebridge value
  mapCurrentDoorState = (state: string) => {
    let stateMappedValue = this.platform.Characteristic.CurrentDoorState.CLOSED;
    switch (state) {
      case 'open':
        stateMappedValue = this.platform.Characteristic.CurrentDoorState.OPEN;
        break;
      case 'opening':
        stateMappedValue = this.platform.Characteristic.CurrentDoorState.OPENING;
        break;
      case 'closed':
        stateMappedValue = this.platform.Characteristic.CurrentDoorState.CLOSED;
        break;
      case 'closing':
        stateMappedValue = this.platform.Characteristic.CurrentDoorState.CLOSING;
        break;
      case 'stopped':
        stateMappedValue = this.platform.Characteristic.CurrentDoorState.STOPPED;
        break;
      default:
        //CLOSED
        break;
    }
    return stateMappedValue;
  };

  // map the value from the chamberlain API to a homebridge value
  mapTargetDoorState = (state: string) => {
    let stateMappedValue = this.platform.Characteristic.TargetDoorState.CLOSED;
    switch (state) {
      case 'open':
        stateMappedValue = this.platform.Characteristic.TargetDoorState.OPEN;
        break;
      case 'closed':
        stateMappedValue = this.platform.Characteristic.TargetDoorState.CLOSED;
        break;
      default:
        //CLOSED
        break;
    }
    return stateMappedValue;
  };
}
