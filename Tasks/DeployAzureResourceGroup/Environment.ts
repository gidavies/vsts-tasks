var networkManagementClient = require("azure-arm-network");
var computeManagementClient = require("azure-arm-compute");
import util = require("util");
import tl = require("vsts-task-lib/task");
import deployAzureRG = require("./DeployAzureRG");
class PropertyValue {
    public IsSecure: boolean;
    public Data: string;

    constructor(data: string, isSecure?: boolean) {
        this.Data = data;
        this.IsSecure = !!isSecure;
    }
}

class Resource {
    public Id: number;
    public Name: string;
    public Properties: { [property: string]: PropertyValue };

    constructor(id: number, name: string) {
        this.Id = id;
        this.Name = name;
        this.Properties = {};
    }

    public addOrUpdateProperty(type: string, property: PropertyValue ) {
        this.Properties[type] = property;
    }
}

class Project {
    public Id: string;
    public Name: string;
    
    constructor(id: string, name: string) {
        this.Id = id;
        this.Name = name;
    }
}

class User {
    public Name: string;

    constructor(name: string) {
        this.Name = name;
    }
}

class Environment {
    public Id: number;
    public Url: string;
    public Revision: number;
    public Project: Project;
    public ModifiedBy: User;
    public Resources: Array<Resource>;
    public Properties: { [property: string]: PropertyValue };
    public Name: string;
    public IsReserved: boolean;
    public CreatedBy: User;
    public CreatedDate: string;
    public ModifiedDate: string;

    constructor(resources: Array<Resource>, userId: string, projectName: string, environmentName: string) {
        this.Id = 0;
        this.Url = "null";
        this.Revision = 1;
        this.Project = new Project(projectName, projectName);
        var user = new User(userId);
        this.ModifiedBy = user;
        this.Resources = resources;
        this.Properties = { 
            "Microsoft-Vslabs-MG-WinRMProtocol": new PropertyValue("HTTPS"), 
            "Microsoft-Vslabs-MG-SkipCACheck": new PropertyValue("False") 
        };
        this.Name = environmentName;
        this.IsReserved = false;
        this.CreatedBy = user;
        var timestamp = new Date();
        this.CreatedDate = util.format("%s-%s-%sT%s:%s:%s.%sZ", timestamp.getFullYear(), timestamp.getMonth(), timestamp.getDate(), 
                                        timestamp.getHours(), timestamp.getMinutes(), timestamp.getSeconds(), timestamp.getMilliseconds());
        this.ModifiedDate = "0001-01-01T00:00:00";
    }
}

export class RegisterEnvironment {
    
    private taskParameters: deployAzureRG.AzureRGTaskParameters;
    private publicAddressToNicIdMap;
    private publicAddressToFqdnMap;
    private nicIdToTagsMap;
    private inboundNatRuleMap;
    private nicIds;
    private loadBalancerToPortMap;
    private loadBalancerToPublicIPAddressMap;

    constructor(taskParameters: deployAzureRG.AzureRGTaskParameters) {
        this.taskParameters = taskParameters;
        this.publicAddressToNicIdMap = null;
        this.nicIdToTagsMap = null;
        this.publicAddressToFqdnMap = null;
        this.loadBalancerToPortMap = null;
        this.nicIds = null;
        this.loadBalancerToPublicIPAddressMap = null;
        this.inboundNatRuleMap = null;
    }

    public RegisterEnvironment () {
        if (!this.taskParameters.outputVariable || !this.taskParameters.outputVariable.trim()) {
            tl.setResult(tl.TaskResult.Failed, "Output variable should not be empty");
            process.exit();
            return;
        }
        console.log("Registering Environment Variable..");
        this.getVMDetails();
        this.getNetworkInterfaceDetails();
        this.getPublicIPAddresses();
        this.getLoadBalancers();
    }
    
    private getLoadBalancers() {
        var armClient = new networkManagementClient(this.taskParameters.credentials, this.taskParameters.subscriptionId);
        armClient.loadBalancers.list(this.taskParameters.resourceGroupName, (error, loadbalancers, request, response) => {
            if (error){
                console.log("Error while getting list of Load Balancers", error);
                throw new Error("FailedToFetchLoadBalancers");
            }
            var inboundNatRuleMap = {};
            for (var i=0; i < loadbalancers.length; i++) {
                var lb = loadbalancers[i];
                var publicAddress = lb["frontendIPConfigurations"][0]["publicIPAddress"]["id"];
                for (var j=0; j < lb["inboundNatRules"].length; j++) {
                    var natRule = lb["inboundNatRules"][j];
                    inboundNatRuleMap[natRule["id"]] = {
                        frontendPort : natRule["frontendPort"],
                        backendPort : natRule["backendPort"],
                        publicAddress : publicAddress
                    }
                }
            }
            this.inboundNatRuleMap = inboundNatRuleMap;
            this.InstantiateEnvironment();
        });
    }

    private InstantiateEnvironment() {
        if (this.publicAddressToNicIdMap == null || this.publicAddressToFqdnMap == null || this.nicIdToTagsMap == null || this.inboundNatRuleMap == null) {
            return;
        }
        var resources = this.getResources();
        tl.debug("Got resources..");
        var environment = new Environment(resources, process.env["SYSTEM_COLLECTIONID"], process.env["SYSTEM_TEAMPROJECT"], this.taskParameters.outputVariable);
        tl.setVariable(this.taskParameters.outputVariable, JSON.stringify(environment));
        console.log("Added the Environment", this.taskParameters.outputVariable,"to output variable")
    }

    private getTags(nicId: string) {
        return this.nicIdToTagsMap[nicId];
    }

    private getPort(nicId: string) {
        var interfaceDetails = this.publicAddressToNicIdMap[nicId];
        var port = "5986";
        if (interfaceDetails.inboundNatRule) {
            var natRules = interfaceDetails.inboundNatRule;
            for (var i=0; i < natRules.length; i++) {
                var natRule = natRules[i];
                if (this.inboundNatRuleMap[natRule.id].backendPort == 5986) {
                    port = this.inboundNatRuleMap[natRule.id].frontendPort
                }
            }
        }
        return port.toString();      
    }

    private getFQDN(nicId) {
        var interfaceDetails = this.publicAddressToNicIdMap[nicId];
        if (interfaceDetails.publicAddress) {
            return this.publicAddressToFqdnMap[interfaceDetails.publicAddress];
        } else {
            var natRule = interfaceDetails.inboundNatRule[0].id;
            var publicAddress = this.inboundNatRuleMap[natRule].publicAddress;
            return this.publicAddressToFqdnMap[publicAddress];
        }
    }

    
    private getResources() {
        var resources = new Array<Resource>();
        var id = 1;
        for (var i=0; i < this.nicIds.length; i++) {
            var nicId = this.nicIds[i];
            var fqdn = this.getFQDN(nicId);
            var resource = new Resource(id++ , fqdn);
            resource.addOrUpdateProperty("Microsoft-Vslabs-MG-Resource-FQDN", new PropertyValue(fqdn));
            resource.addOrUpdateProperty("WinRM_Https", new PropertyValue(this.getPort(nicId)));
            var tags = this.getTags(nicId);
            if (tags) {
                for (var tag in tags) {
                    resource.addOrUpdateProperty(tag, new PropertyValue(tags[tag]));
                }
            }
            resources.push(resource);
        }
        return resources;
    }

    private getVMDetails() {
        var armClient = new computeManagementClient(this.taskParameters.credentials, this.taskParameters.subscriptionId);
        armClient.virtualMachines.list(this.taskParameters.resourceGroupName, (error, virtualMachines, request, response) => {
            if (error){
                console.log("Error while getting list of Virtual Machines", error);
                throw new Error("FailedToFetchVMs");
            }
            this.nicIds = [];
            var tags = {};
            for (var i = 0; i < virtualMachines.length; i++) {
                var vm = virtualMachines[i];
                var nicId = vm["networkProfile"]["networkInterfaces"][0]["id"];
                this.nicIds.push(nicId);
                if (vm["tags"] != undefined)
                    tags[nicId] = vm["tags"];
            }
            this.nicIdToTagsMap = tags;
            this.InstantiateEnvironment();            
        });
    }

    private getNetworkInterfaceDetails() {
        var armClient = new networkManagementClient(this.taskParameters.credentials, this.taskParameters.subscriptionId);
        armClient.networkInterfaces.list(this.taskParameters.resourceGroupName, (error, networkInterfaces, request, response) => {
            if (error){
                console.log("Error while getting list of Network Interfaces", error);
                throw new Error("FailedToFetchNetworkInterfaces");
            }
            var interfaces = {};
            for (var i = 0; i < networkInterfaces.length; i++) {
                var networkInterface = networkInterfaces[i];
                var nicId = networkInterface["id"];
                var ipConfig = networkInterface["ipConfigurations"][0];
                if (ipConfig["publicIPAddress"]){
                    interfaces[nicId] = { publicAddress: ipConfig["publicIPAddress"]["id"] };
                } else if (ipConfig["loadBalancerInboundNatRules"]) {
                    interfaces[nicId] ={ inboundNatRule: ipConfig["loadBalancerInboundNatRules"] };
                }
            }
            this.publicAddressToNicIdMap = interfaces;
            this.InstantiateEnvironment();  
        });
    }

    private getPublicIPAddresses() {
        var armClient = new networkManagementClient(this.taskParameters.credentials, this.taskParameters.subscriptionId);
        armClient.publicIPAddresses.list(this.taskParameters.resourceGroupName, (error, publicAddresses, request, response) => {
            if (error){
                console.log("Error while getting list of Public Addresses", error);
                throw new Error("FailedToFetchPublicAddresses");
            }
            var fqdns = {}
            for (var i = 0; i < publicAddresses.length; i++) {
                var publicAddress = publicAddresses[i];
                var publicAddressId = publicAddress["id"];
                if (publicAddress["dnsSettings"]) {
                    fqdns[publicAddressId] = publicAddress["dnsSettings"]["fqdn"];
                }
                else {
                    fqdns[publicAddressId] = publicAddress["ipAddress"];
                }
            }
            this.publicAddressToFqdnMap = fqdns;
            this.InstantiateEnvironment();
        });
    }
    
}

