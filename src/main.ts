import { AutoScalingGroup, GroupMetrics, Monitoring } from '@aws-cdk/aws-autoscaling';
import { InstanceType, Port, Vpc } from '@aws-cdk/aws-ec2';
import { AsgCapacityProvider, AwsLogDriver, AwsLogDriverMode, Cluster, ContainerImage, Ec2Service, Ec2TaskDefinition, EcsOptimizedImage } from '@aws-cdk/aws-ecs';
import { ApplicationLoadBalancer, ListenerCertificate } from '@aws-cdk/aws-elasticloadbalancingv2';
import { Policy, PolicyStatement, Effect } from '@aws-cdk/aws-iam';
import { ARecord, HostedZone, RecordTarget } from '@aws-cdk/aws-route53';
import { LoadBalancerTarget } from '@aws-cdk/aws-route53-targets';
import { StringParameter } from '@aws-cdk/aws-ssm';
import { App, Construct, Stack, StackProps, CfnOutput, Duration } from '@aws-cdk/core';

//https://www.npmjs.com/package/@aws-cdk-containers/ecs-service-extensions?activeTab=readme

interface MyStackProps extends StackProps {
  vpcTagName?: string; // Specify if you want to reuse existing VPC (or "default" for default VPC), else it will create a new one
  clusterName: string; // Specify if you want to reuse existing ECS cluster, else it will create new one
  createCluster: boolean;
  domainZone: string;
  domainName: string;
}

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: MyStackProps) {
    super(scope, id, props);

    // define resources here...

    const domainZone = HostedZone.fromLookup(this, 'Zone', { domainName: props.domainZone });

    //Define VPC
    var vpc = undefined;
    if (props.vpcTagName) {
      if (props.vpcTagName == 'default') {
        vpc = Vpc.fromLookup(this, 'VPC', { isDefault: true });
      } else {
        vpc = Vpc.fromLookup(this, 'VPC', { tags: { Name: props.vpcTagName } });
      }
    } else {
      vpc = new Vpc(this, 'VPC', { maxAzs: 2 });
    }


    //https://github.com/PasseiDireto/gh-runner-ecs-ec2-stack/blob/cc6c13824bec5081e2d39a7adf7e9a2d0c8210a1/cluster.ts
    const autoScalingGroup1: AutoScalingGroup = new AutoScalingGroup(this, 'Asg', {
      vpc,
      machineImage: EcsOptimizedImage.amazonLinux2(),
      instanceType: new InstanceType('t3.micro'),
      //machineImage: new ecs.BottleRocketImage(),
      minCapacity: 1,
      maxCapacity: 100,
      instanceMonitoring: Monitoring.DETAILED,
      groupMetrics: [GroupMetrics.all()],
      // https://github.com/aws/aws-cdk/issues/11581
      //updateType: undefined,
    });
    //  asg.addUserData(
    //   'sudo -s',
    //   '/usr/bin/sysbox',
    //   'docker restart',
    //   `echo ECS_CLUSTER=${cluster.clusterName} | tee /etc/ecs/ecs.config`,
    //   'echo ECS_LOGFILE=/log/ecs-agent.log | tee -a /etc/ecs/ecs.config',
    //   'echo ECS_AVAILABLE_LOGGING_DRIVERS=[\\"json-file\\",\\"syslog\\",\\"awslogs\\",\\"fluentd\\",\\"none\\"] | tee -a /etc/ecs/ecs.config',
    //   'echo ECS_ENABLE_AWSLOGS_EXECUTIONROLE_OVERRIDE=true | tee -a /etc/ecs/ecs.config',
    //   'echo ECS_ENABLE_TASK_IAM_ROLE=true | tee -a /etc/ecs/ecs.config',
    //   'echo ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST=true | tee -a /etc/ecs/ecs.config',
    //   'echo ECS_DATADIR=/data | tee -a /etc/ecs/ecs.config',
    //   'echo ECS_AWSVPC_BLOCK_IMDS=true | tee -a /etc/ecs/ecs.config',
    //   'curl -o ecs-agent.tar https://s3.us-east-2.amazonaws.com/amazon-ecs-agent-us-east-2/ecs-agent-latest.tar',
    //   'docker load --input ./ecs-agent.tar',
    //   'docker run --name ecs-agent --privileged --detach=true --restart=on-failure:10 --volume=/var/run:/var/run --volume=/var/log/ecs/:/log:Z --volume=/var/lib/ecs/data:/data:Z --volume=/etc/ecs:/etc/ecs --net=host --userns=host --runtime=runc --env-file=/etc/ecs/ecs.config amazon/amazon-ecs-agent:latest'
    // );

    const capacityProvider1 = new AsgCapacityProvider(this, 'CP1', {
      //capacityProviderName: 'cp1',
      autoScalingGroup: autoScalingGroup1,
      enableManagedScaling: true,
      enableManagedTerminationProtection: true,
      targetCapacityPercent: 70,
    });

    //Define ECS Cluster
    // Reference existing network and cluster infrastructure
    var cluster = undefined;
    if (!props.createCluster) {
      cluster = Cluster.fromClusterAttributes(this, 'Cluster', {
        clusterName: props.clusterName,
        vpc: vpc,
        securityGroups: [],
      });
    } else {
      cluster = new Cluster(this, 'Cluster', {
        clusterName: props.clusterName,
        vpc,
        containerInsights: true,
        enableFargateCapacityProviders: true,
      });

      cluster.addAsgCapacityProvider(capacityProvider1);
    }
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });


    //Define TLS Certificate
    // Lookup pre-existing TLS certificate
    const certificateArn = StringParameter.fromStringParameterAttributes(this, 'CertArnParameter', {
      parameterName: 'CertificateArn-' + props.domainZone,
    }).stringValue;
    //const certificate = Certificate.fromCertificateArn(this, 'Cert', certificateArn);
    const certificate = ListenerCertificate.fromArn(certificateArn);


    const taskDefinition = new Ec2TaskDefinition(this, props.clusterName );


    const container = taskDefinition.addContainer('container', {
      //image: ContainerImage.fromRegistry('ruecarlo/monte-carlo-pi-service'),
      image: ContainerImage.fromAsset('./app/'),
      logging: new AwsLogDriver({ streamPrefix: 'montecarlo', mode: AwsLogDriverMode.NON_BLOCKING }),
      //executionRole:
      //taskRole:
      //containerPort: 80,
      memoryReservationMiB: 256,
      cpu: 256,
    });
    container.addPortMappings({
      containerPort: 8080,
    });

    //https://docs.aws.amazon.com/cdk/api/latest/docs/aws-ecs-readme.html
    const service = new Ec2Service(this, 'Ec2Service', {
      cluster,
      //serviceName: 'cdk-montecarlo-asg',
      taskDefinition,
      enableExecuteCommand: true,
      //circuitBreaker: { rollback: true },
      // cloudMapOptions: {
      //   // Create A records - useful for AWSVPC network mode.
      //   dnsRecordType: DnsRecordType.A,
      // },
      capacityProviderStrategies: [
        {
          capacityProvider: capacityProvider1.capacityProviderName,
          weight: 2,
          base: 1,
        },
        // {
        //   capacityProvider: capacityProvider2.capacityProviderName,
        //   weight: 1,
        // },
      ],
    });

    const lb = new ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
      //loadBalancerName: 'cdk-montecarlo-asg',
    });
    const record = new ARecord(this, 'AliasRecord', {
      zone: domainZone,
      recordName: props.domainName + '.' + props.domainZone,
      target: RecordTarget.fromAlias(new LoadBalancerTarget(lb)),
    });
    new CfnOutput(this, 'URL', { value: 'https://' + record.domainName });

    const listener = lb.addListener('Listener', { port: 443 });
    listener.addCertificates('cert', [certificate]);
    const targetGroup = listener.addTargets('montecarlo', {
      // priority: 1,
      // conditions: [
      //   ListenerCondition.hostHeaders([props.domainName + '.' + props.domainZone]),
      //   ListenerCondition.pathPatterns(['/*']),
      // ],
      port: 8080,
      //targets: [autoScalingGroup1],
      targets: [service],
    });
    lb.addRedirect; //default to http -> https

    lb.connections.allowTo(autoScalingGroup1.connections, Port.allTraffic());
    autoScalingGroup1.connections.allowFrom(lb.connections, Port.allTraffic());

    // spotAsg.connections.allowFrom(
    //   ec2.SecurityGroup.fromSecurityGroupId(this, "spotAsgIngress" + AZs[az], cluster.clusterSecurityGroupId),
    //   ec2.Port.allTraffic(),
    //   "allow all traffic from cluster security group"
    // );
    //spotAsg.connections.allowToAnyIpv4(ec2.Port.allTraffic(), "Allow ALL");
    // spotAsg.connections.allowTo(
    //   ec2.SecurityGroup.fromSecurityGroupId(this, "spotAsgEgress" + AZs[az], cluster.clusterSecurityGroupId),
    //   ec2.Port.allTraffic(),
    //   "allow all traffic to the cluster Security group"
    // );

    new CfnOutput(this, 'EcsService', { value: service.serviceName });

    //https://github.com/bobbyhadz/aws-cdk-application-load-balancer/blob/master/lib/cdk-starter-stack.ts

    // SConfigure Load Balancer TargetGroups for peed up deployments
    targetGroup.setAttribute('deregistration_delay.timeout_seconds', '120');
    targetGroup.configureHealthCheck({
      interval: Duration.seconds(35),
      healthyHttpCodes: '200',
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
      timeout: Duration.seconds(30),
      path: '/',
    });

    var policyStatement = new PolicyStatement({
      effect: Effect.ALLOW,
      resources: ['*'],
      actions: [
        'ecs:ListTasks',
        'ecs:DescribeTasks',
      ],
    });

    service.taskDefinition.taskRole.attachInlinePolicy(new Policy(this, 'policy', {
      statements: [
        policyStatement,
      ],
    }));

    //add Autoscaling
    const scaling = service.autoScaleTaskCount({ maxCapacity: 60, minCapacity: 5 });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 50,
    });

    scaling.scaleOnRequestCount('RequestScaling', {
      requestsPerTarget: 10000,
      targetGroup: targetGroup,
    });


  }
}


const domainName = process.env.DOMAIN_NAME ? process.env.DOMAIN_NAME : 'cdk-montecarlo-asg2';
const domainZone = process.env.DOMAIN_ZONE ? process.env.DOMAIN_ZONE : 'route53.hosted.zone';
const vpcTagName = process.env.VPC_TAG_NAME; //? process.env.VPC_TAG_NAME : 'ecsworkshop-base/BaseVPC';
const clusterName = process.env.CLUSTER_NAME ? process.env.CLUSTER_NAME : domainName;

const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new MyStack(app, domainName, {
  domainName: domainName,
  domainZone: domainZone,
  vpcTagName: vpcTagName,
  clusterName: clusterName,
  createCluster: true,
  env: devEnv,
});


app.synth();